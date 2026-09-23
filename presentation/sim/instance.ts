// presentation/sim/instance.ts
import type { EventHandle, Sim } from './engine'
import { Pool, type PoolOpts } from './pool'
import type { Outcome, Request } from './types'

export type InstanceState = 'booting' | 'ready' | 'terminated'

export type Work = (req: Request, finish: (outcome: Outcome) => void) => void

/** One step of a request's plan: acquire the named pool, hold it `ms`, release. */
export interface Step {
  pool: string
  scope: 'instance' | 'cluster'
  ms: number
}

export interface InstanceOpts {
  /** Delay before the instance can serve; number or sampler. */
  bootTime: number | (() => number)
  /** Envelope pool: held for a request's entire lifetime (arrival → completion). Models thread/coroutine count. */
  workerPool: PoolOpts
  /** The CPU pool — what `.cpu` reports. A step naming pool 'cpu' with scope 'instance' resolves here. */
  cpuPool: PoolOpts
  /** Other named instance-scoped pools (e.g. a local connection pool), built fresh per instance. */
  instancePools?: Record<string, PoolOpts>
  /** Cluster-scoped pools, shared by reference across every instance in the cluster (e.g. a DB pool). Wired in by Cluster. */
  clusterPools?: Record<string, Pool>
  /** Per-request step plan, built at arrival (same closure-sampling pattern as bootTime). Default: no steps (instant completion). */
  steps?: () => Step[]
  /** Override how a request is served (e.g. call an upstream) — bypasses `steps` entirely. */
  work?: Work
  /** CPU reported while hung (0 = stuck on I/O, 1 = spinning). Default: worker pool's busy fraction (`utilization`). */
  hungCpu?: number
  /** Uniform [0,1) sampler used to roll poison on pool release. Default: never poisons. */
  rollUniform?: () => number
}

interface Occupant {
  req: Request
  plan: Step[]
  stepIndex: number
  /** The sub-resource currently held for the in-progress step, if any. */
  cur?: { pool: Pool; poolSlot: number; scope: 'instance' | 'cluster' }
  handle?: EventHandle
  resumeAt?: number
}

/** One scaling unit: boots, then serves requests via a worker-pool envelope wrapping a per-request step pipeline. */
export class Instance {
  state: InstanceState = 'booting'
  onDone: (req: Request) => void = () => {}
  readonly launchedAt: number
  readySince?: number

  private readonly workerPool: Pool
  private readonly cpuPool: Pool
  private readonly instancePools: Record<string, Pool>
  private readonly clusterPools: Record<string, Pool>
  private occupants: (Occupant | null)[]
  /** Requests waiting on a worker slot. Duplicates bookkeeping `workerPool`'s own waiter queue
   *  already provides, because `Pool`'s generic `(slot: number) => void` callback queue can't hand
   *  back the `Request` objects `terminate()` needs for its victim list. */
  private workerQueue: Request[] = []
  private bootHandle?: EventHandle
  private hungUntil = -Infinity
  private slowUntil = -Infinity
  private slowFactor = 1

  constructor(private sim: Sim, private opts: InstanceOpts) {
    this.launchedAt = sim.now
    this.workerPool = new Pool(sim, opts.workerPool)
    this.cpuPool = new Pool(sim, opts.cpuPool)
    this.instancePools = {}
    for (const [name, poolOpts] of Object.entries(opts.instancePools ?? {})) this.instancePools[name] = new Pool(sim, poolOpts)
    this.clusterPools = opts.clusterPools ?? {}
    this.occupants = new Array(opts.workerPool.slots).fill(null)

    const boot = typeof opts.bootTime === 'function' ? opts.bootTime() : opts.bootTime
    const ready = () => { this.state = 'ready'; this.readySince = this.sim.now }
    if (boot === 0) ready()
    else this.bootHandle = sim.schedule(boot, ready)
  }

  get inFlight(): number { return this.workerPool.occupied }
  get queued(): number { return this.workerQueue.length }
  get utilization(): number { return this.workerPool.occupied / this.workerPool.slots }
  get hung(): boolean { return this.sim.now < this.hungUntil }
  /** What a health check sees: serving and not stuck. */
  get healthy(): boolean { return this.state === 'ready' && !this.hung }
  /** What a metrics agent reports — the cpu pool's honest busy fraction; lies while hung, by design. */
  get cpu(): number {
    if (this.hung) return this.opts.hungCpu ?? this.utilization
    return this.cpuPool.occupied / this.cpuPool.slots
  }

  /** Stop completing anything for `duration`; in-progress steps keep their occupant but push their timer out. */
  hang(duration: number): void {
    this.hungUntil = Math.max(this.hungUntil, this.sim.now + duration)
    for (let i = 0; i < this.occupants.length; i++) {
      const occ = this.occupants[i]
      if (!occ || !occ.cur || !occ.handle || occ.resumeAt === undefined) continue
      occ.handle.cancel()
      occ.resumeAt = this.hungUntil + Math.max(0, occ.resumeAt - this.sim.now)
      this.scheduleStepCompletion(i, occ)
    }
  }

  /** Instance-scoped step ms × `factor` for steps starting during `duration`. Cluster-scoped steps are unaffected — a local fault shouldn't inflate a shared upstream's time. */
  slow(factor: number, duration: number): void {
    this.slowFactor = factor
    this.slowUntil = this.sim.now + duration
  }

  handle(req: Request): void {
    if (this.state !== 'ready') return this.finish(req, 'rejected')
    const workerSlot = this.workerPool.tryAcquire()
    if (workerSlot !== undefined) return this.start(req, workerSlot)
    const queued = this.workerPool.enqueue((s) => {
      const idx = this.workerQueue.indexOf(req)
      if (idx >= 0) this.workerQueue.splice(idx, 1)
      this.start(req, s)
    })
    if (queued) this.workerQueue.push(req)
    else this.finish(req, 'rejected')
  }

  /**
   * NOTE: a terminated instance's waiters queued in a *shared* cluster pool are not removed
   * from that pool's queue (only instance-scoped pools get `forceReset()`, which clears their
   * queues — cluster pools are shared and deliberately left untouched). Such a dead waiter
   * spuriously counts against that pool's `queueLimit` until the pool's FIFO order naturally
   * reaches it, at which point the staleness guard in `holdStep` renders it inert (it's a no-op,
   * not a leak — see the `scope === 'cluster'` branch there).
   */
  terminate(): void {
    this.state = 'terminated'
    this.bootHandle?.cancel()
    const victims: Request[] = []
    const toRelease: { pool: Pool; poolSlot: number }[] = []
    for (const occ of this.occupants) {
      if (!occ) continue
      occ.handle?.cancel()
      if (occ.cur && occ.cur.scope === 'cluster') toRelease.push({ pool: occ.cur.pool, poolSlot: occ.cur.poolSlot })
      victims.push(occ.req)
    }
    victims.push(...this.workerQueue)
    this.workerQueue = []
    // Null out occupants BEFORE releasing any cluster-scoped held slots: Pool.release() can
    // synchronously hand a freed slot to another queued waiter, and if that waiter belongs to
    // another occupant of THIS instance, its holdStep staleness check (`occupants[workerSlot] !== occ`)
    // must already see the cleared occupants array, or it will proceed as if still alive and
    // schedule a completion that nothing later cancels (double-finish / negative occupancy).
    this.occupants = new Array(this.occupants.length).fill(null)
    this.workerPool.forceReset()
    this.cpuPool.forceReset()
    for (const pool of Object.values(this.instancePools)) pool.forceReset()
    for (const { pool, poolSlot } of toRelease) pool.release(poolSlot, false)
    for (const r of victims) this.finish(r, 'error')
  }

  private start(req: Request, workerSlot: number): void {
    req.startedAt = this.sim.now
    if (this.opts.work) {
      const occ: Occupant = { req, plan: [], stepIndex: 0 }
      this.occupants[workerSlot] = occ
      this.opts.work(req, (outcome) => {
        if (this.occupants[workerSlot] !== occ) return // instance terminated in the meantime
        this.finishWorker(workerSlot, occ, outcome ?? 'ok')
      })
      return
    }
    const occ: Occupant = { req, plan: this.opts.steps ? this.opts.steps() : [], stepIndex: 0 }
    this.occupants[workerSlot] = occ
    this.runStep(workerSlot, occ)
  }

  private runStep(workerSlot: number, occ: Occupant): void {
    // NOTE: an empty plan (default when `steps` is omitted) finishes synchronously here even if the
    // instance is currently hung — `hang()`'s "stop completing anything" guarantee only applies to
    // steps that are actually in flight. Nothing in this codebase constructs an Instance with both
    // `work` and `steps` unset while relying on hang-blocking, so this edge case is left undocumented
    // in behavior, just noted here.
    if (occ.stepIndex >= occ.plan.length) return this.finishWorker(workerSlot, occ, 'ok')
    const step = occ.plan[occ.stepIndex]!
    let ms = step.ms
    if (step.scope === 'instance' && this.sim.now < this.slowUntil) ms *= this.slowFactor
    const pool = step.scope === 'cluster'
      ? this.clusterPools[step.pool]
      : step.pool === 'cpu' ? this.cpuPool : this.instancePools[step.pool]
    if (!pool) throw new Error(`unknown ${step.scope} pool "${step.pool}"`)
    const acquired = pool.tryAcquire()
    if (acquired !== undefined) return this.holdStep(workerSlot, occ, pool, acquired, ms, step.scope)
    const queued = pool.enqueue((s) => this.holdStep(workerSlot, occ, pool, s, ms, step.scope))
    if (!queued) this.finishWorker(workerSlot, occ, 'rejected')
  }

  private holdStep(workerSlot: number, occ: Occupant, pool: Pool, poolSlot: number, ms: number, scope: 'instance' | 'cluster'): void {
    if (this.occupants[workerSlot] !== occ) {
      // Instance terminated while this step waited in the pool's queue — don't leak a shared slot.
      if (scope === 'cluster') pool.release(poolSlot, false)
      return
    }
    occ.cur = { pool, poolSlot, scope }
    occ.resumeAt = Math.max(this.sim.now, this.hungUntil) + ms
    this.scheduleStepCompletion(workerSlot, occ)
  }

  private scheduleStepCompletion(workerSlot: number, occ: Occupant): void {
    const { pool, poolSlot } = occ.cur!
    occ.handle = this.sim.scheduleAt(occ.resumeAt!, () => {
      const poisoned = pool.poisonProb > 0 && this.rollUniform() < pool.poisonProb
      pool.release(poolSlot, poisoned)
      occ.cur = undefined
      occ.stepIndex++
      this.runStep(workerSlot, occ)
    })
  }

  private finishWorker(workerSlot: number, occ: Occupant, outcome: Outcome): void {
    this.occupants[workerSlot] = null
    const poisoned = this.workerPool.poisonProb > 0 && this.rollUniform() < this.workerPool.poisonProb
    this.workerPool.release(workerSlot, poisoned)
    this.finish(occ.req, outcome)
  }

  private rollUniform(): number {
    return this.opts.rollUniform ? this.opts.rollUniform() : 1
  }

  private finish(req: Request, outcome: Outcome): void {
    req.doneAt = this.sim.now
    req.outcome = outcome
    this.onDone(req)
  }
}
