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
}

interface Active {
  req: Request
  handle?: EventHandle
  /** When the default work would finish, so a hang can push it out. */
  finishAt?: number
  finish?: (outcome: Outcome) => void
}

/** One scaling unit: boots, then serves requests up to `concurrency` at a time. */
export class Instance {
  state: InstanceState = 'booting'
  onDone: (req: Request) => void = () => {}
  readonly busy: TimeWeighted
  readonly launchedAt: number
  readySince?: number

  private active = new Map<number, Active>()
  private queue: Request[] = []
  private bootHandle?: EventHandle
  private hungUntil = -Infinity
  private slowUntil = -Infinity
  private slowFactor = 1

  constructor(private sim: Sim, private opts: InstanceOpts) {
    this.busy = new TimeWeighted(sim, 0)
    this.launchedAt = sim.now
    const boot = typeof opts.bootTime === 'function' ? opts.bootTime() : opts.bootTime
    const ready = () => { this.state = 'ready'; this.readySince = this.sim.now }
    if (boot === 0) ready()
    else this.bootHandle = sim.schedule(boot, ready)
  }

  get inFlight(): number { return this.active.size }
  get queued(): number { return this.queue.length }
  get utilization(): number { return this.active.size / this.opts.concurrency }
  get hung(): boolean { return this.sim.now < this.hungUntil }
  /** What a health check sees: serving and not stuck. */
  get healthy(): boolean { return this.state === 'ready' && !this.hung }
  /** What a metrics agent reports — lies while hung, by design. */
  get cpu(): number { return this.hung ? (this.opts.hungCpu ?? this.utilization) : this.utilization }

  /** Stop completing anything for `duration`; requests keep piling into slots. */
  hang(duration: number): void {
    this.hungUntil = Math.max(this.hungUntil, this.sim.now + duration)
    for (const a of this.active.values()) {
      if (a.handle && a.finishAt !== undefined && a.finish) {
        a.handle.cancel()
        a.finishAt = this.hungUntil + Math.max(0, a.finishAt - this.sim.now)
        a.handle = this.sim.scheduleAt(a.finishAt, () => a.finish!('ok'))
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
    if (this.active.size < this.opts.concurrency) return this.start(req)
    if (this.queue.length < this.opts.queueLimit) { this.queue.push(req); return }
    this.finish(req, 'rejected')
  }

  terminate(): void {
    this.state = 'terminated'
    this.bootHandle?.cancel()
    for (const a of this.active.values()) a.handle?.cancel()
    const victims = [...this.active.values()].map((a) => a.req).concat(this.queue)
    this.active.clear()
    this.queue = []
    this.busy.set(0)
    for (const r of victims) this.finish(r, 'error')
  }

  private start(req: Request): void {
    req.startedAt = this.sim.now
    const entry: Active = { req }
    this.active.set(req.id, entry)
    this.busy.set(this.utilization)
    const finish = (outcome: Outcome) => {
      if (!this.active.delete(req.id)) return // already killed by terminate()
      this.busy.set(this.utilization)
      this.finish(req, outcome)
      const next = this.queue.shift()
      if (next) this.start(next)
    }
    if (this.opts.work) {
      this.opts.work(req, finish)
    } else {
      let factor = this.opts.slowdown ? this.opts.slowdown(this.active.size) : 1
      if (this.sim.now < this.slowUntil) factor *= this.slowFactor
      const service = this.opts.serviceTime() * factor
      entry.finish = finish
      entry.finishAt = Math.max(this.sim.now, this.hungUntil) + service
      entry.handle = this.sim.scheduleAt(entry.finishAt, () => finish('ok'))
    }
  }

  private finish(req: Request, outcome: Outcome): void {
    req.doneAt = this.sim.now
    req.outcome = outcome
    this.onDone(req)
  }
}
