import type { EventHandle, Sim } from './engine'
import { TimeWeighted } from './metrics'
import type { Outcome, Request } from './types'

export type InstanceState = 'booting' | 'ready' | 'terminated'

export type Work = (req: Request, finish: (outcome: Outcome) => void) => void

export interface InstanceOpts {
  /** Delay before the instance can serve; number or sampler. */
  bootTime: number | (() => number)
  /** Service time sampler (used by the default work). */
  serviceTime: () => number
  /** Max requests in flight (thread pool / worker count). */
  concurrency: number
  /** Waiting slots beyond concurrency; 0 = reject when all busy. */
  queueLimit: number
  /** Multiplier on service time given current inFlight — models degradation. */
  slowdown?: (inFlight: number) => number
  /** Override how a request is served (e.g. call an upstream). */
  work?: Work
  /** CPU reported while hung (0 = stuck on I/O, 1 = spinning). Default: slots busy. */
  hungCpu?: number
  /**
   * Override what "busy" is reported as, given current inFlight (0..1).
   * Default: inFlight / concurrency. Needed when concurrency is set high to
   * model an effectively-unbounded pool (e.g. the node.js unit model) —
   * plain utilization would then never approach 1, but a real event-loop
   * utilization metric saturates at 1 well before that.
   */
  cpuReport?: (inFlight: number) => number
}

/**
 * One service slot: occupied by at most one request at a time. Slots and their
 * completion callbacks are allocated once per instance, so the per-request
 * hot path allocates nothing (the Request itself excepted).
 */
interface Slot {
  req: Request | null
  handle?: EventHandle
  /** When the default work would finish, so a hang can push it out. */
  finishAt?: number
}

/** One scaling unit: boots, then serves requests up to `concurrency` at a time. */
export class Instance {
  state: InstanceState = 'booting'
  onDone: (req: Request) => void = () => {}
  readonly busy: TimeWeighted
  readonly launchedAt: number
  readySince?: number

  private slots: Slot[]
  private free: number[] = []
  /** Pre-bound completion callback per slot — the scheduled event fires it with no args → 'ok'. */
  private slotFinish: ((outcome?: Outcome) => void)[]
  private queue: Request[] = []
  private bootHandle?: EventHandle
  private hungUntil = -Infinity
  private slowUntil = -Infinity
  private slowFactor = 1

  constructor(private sim: Sim, private opts: InstanceOpts) {
    this.busy = new TimeWeighted(sim, 0)
    this.launchedAt = sim.now
    const n = opts.concurrency
    this.slots = new Array(n)
    this.slotFinish = new Array(n)
    for (let i = 0; i < n; i++) {
      this.slots[i] = { req: null }
      this.free.push(i)
      this.slotFinish[i] = (outcome) => this.complete(i, outcome)
    }
    const boot = typeof opts.bootTime === 'function' ? opts.bootTime() : opts.bootTime
    const ready = () => { this.state = 'ready'; this.readySince = this.sim.now }
    if (boot === 0) ready()
    else this.bootHandle = sim.schedule(boot, ready)
  }

  get inFlight(): number { return this.opts.concurrency - this.free.length }
  get queued(): number { return this.queue.length }
  get utilization(): number { return this.inFlight / this.opts.concurrency }
  get hung(): boolean { return this.sim.now < this.hungUntil }
  /** What a health check sees: serving and not stuck. */
  get healthy(): boolean { return this.state === 'ready' && !this.hung }
  /** What a metrics agent reports — lies while hung, by design. */
  get cpu(): number {
    if (this.hung) return this.opts.hungCpu ?? this.utilization
    return this.opts.cpuReport ? this.opts.cpuReport(this.inFlight) : this.utilization
  }

  /** Stop completing anything for `duration`; requests keep piling into slots. */
  hang(duration: number): void {
    this.hungUntil = Math.max(this.hungUntil, this.sim.now + duration)
    for (let i = 0; i < this.slots.length; i++) {
      const s = this.slots[i]!
      if (s.req && s.handle && s.finishAt !== undefined) {
        s.handle.cancel()
        s.finishAt = this.hungUntil + Math.max(0, s.finishAt - this.sim.now)
        s.handle = this.sim.scheduleAt(s.finishAt, this.slotFinish[i]!)
      }
    }
  }

  /** Service time × `factor` for new requests during `duration`. */
  slow(factor: number, duration: number): void {
    this.slowFactor = factor
    this.slowUntil = this.sim.now + duration
  }

  handle(req: Request): void {
    if (this.state !== 'ready') return this.finish(req, 'rejected')
    if (this.free.length > 0) return this.start(req)
    if (this.queue.length < this.opts.queueLimit) { this.queue.push(req); return }
    this.finish(req, 'rejected')
  }

  terminate(): void {
    this.state = 'terminated'
    this.bootHandle?.cancel()
    const victims: Request[] = []
    for (const s of this.slots) {
      s.handle?.cancel()
      if (s.req) victims.push(s.req)
      s.req = null
      s.handle = undefined
      s.finishAt = undefined
    }
    victims.push(...this.queue)
    this.queue = []
    this.free.length = 0
    for (let i = 0; i < this.slots.length; i++) this.free.push(i)
    this.busy.set(0)
    for (const r of victims) this.finish(r, 'error')
  }

  private start(req: Request): void {
    const i = this.free.pop()!
    req.startedAt = this.sim.now
    const s = this.slots[i]!
    s.req = req
    this.busy.set(this.utilization)
    if (this.opts.work) {
      // The guard req keeps a late or duplicate finish from completing a slot's next occupant.
      this.opts.work(req, (outcome) => this.complete(i, outcome, req))
    } else {
      let factor = this.opts.slowdown ? this.opts.slowdown(this.inFlight) : 1
      if (this.sim.now < this.slowUntil) factor *= this.slowFactor
      const service = this.opts.serviceTime() * factor
      s.finishAt = Math.max(this.sim.now, this.hungUntil) + service
      s.handle = this.sim.scheduleAt(s.finishAt, this.slotFinish[i]!)
    }
  }

  /** Finish whatever occupies slot `i` (default path) or `req`'s slot (work path). */
  private complete(i: number, outcome: Outcome | undefined, expect?: Request): void {
    const s = this.slots[i]!
    const req = s.req
    if (!req || (expect !== undefined && req !== expect)) return // already completed or terminated
    s.req = null
    s.handle = undefined
    s.finishAt = undefined
    this.free.push(i)
    this.busy.set(this.utilization)
    this.finish(req, outcome ?? 'ok')
    if (this.queue.length) this.start(this.queue.shift()!)
  }

  private finish(req: Request, outcome: Outcome): void {
    req.doneAt = this.sim.now
    req.outcome = outcome
    this.onDone(req)
  }
}
