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
}

interface Active {
  req: Request
  handle?: EventHandle
}

/** One scaling unit: boots, then serves requests up to `concurrency` at a time. */
export class Instance {
  state: InstanceState = 'booting'
  onDone: (req: Request) => void = () => {}
  readonly busy: TimeWeighted

  private active = new Map<number, Active>()
  private queue: Request[] = []
  private bootHandle?: EventHandle

  constructor(private sim: Sim, private opts: InstanceOpts) {
    this.busy = new TimeWeighted(sim, 0)
    const boot = typeof opts.bootTime === 'function' ? opts.bootTime() : opts.bootTime
    if (boot === 0) this.state = 'ready'
    else this.bootHandle = sim.schedule(boot, () => { this.state = 'ready' })
  }

  get inFlight(): number { return this.active.size }
  get queued(): number { return this.queue.length }
  get utilization(): number { return this.active.size / this.opts.concurrency }

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
      const factor = this.opts.slowdown ? this.opts.slowdown(this.active.size) : 1
      entry.handle = this.sim.schedule(this.opts.serviceTime() * factor, () => finish('ok'))
    }
  }

  private finish(req: Request, outcome: Outcome): void {
    req.doneAt = this.sim.now
    req.outcome = outcome
    this.onDone(req)
  }
}
