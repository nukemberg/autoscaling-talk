import type { EventHandle, Sim } from './engine'
import { TimeWeighted } from './metrics'
import type { Outcome } from './types'
import type { Work } from './instance'

export interface UpstreamOpts {
  /** Max concurrent queries (connections / worker threads). */
  capacity: number
  serviceTime: () => number
  /** Queries waiting for a slot; beyond this → error (refused). */
  queueLimit: number
  /** Service-time multiplier as a function of utilization (inFlight / capacity). */
  slowdown?: (utilization: number) => number
  /** Caller gives up after this long; the query keeps running anyway. */
  timeout?: number
  /** Overload knocks the upstream over: everything fails for `recovery`. */
  collapse?: { queueThreshold: number; recovery: number }
}

type Done = (outcome: Outcome) => void

interface Call {
  done: Done
  settled: boolean
  timeout?: EventHandle
}

/** Shared dependency (DB, cache, API) with finite capacity and failure modes. */
export class Upstream {
  state: 'up' | 'down' = 'up'
  readonly busy: TimeWeighted

  private active = new Set<Call>()
  private queue: Call[] = []
  private slowUntil = -Infinity
  private slowFactor = 1

  constructor(private sim: Sim, private opts: UpstreamOpts) {
    this.busy = new TimeWeighted(sim, 0)
  }

  get inFlight(): number { return this.active.size }
  get queued(): number { return this.queue.length }
  get utilization(): number { return this.active.size / this.opts.capacity }

  /** Fault: down for `duration`; everything in progress fails. */
  outage(duration: number): void {
    this.collapse(duration)
  }

  /** Fault: service time × factor for new queries during `duration`. */
  slow(factor: number, duration: number): void {
    this.slowFactor = factor
    this.slowUntil = this.sim.now + duration
  }

  call(done: Done): void {
    if (this.state === 'down') return done('error')
    const c: Call = { done, settled: false }
    if (this.opts.timeout !== undefined) {
      c.timeout = this.sim.schedule(this.opts.timeout, () => {
        this.queue = this.queue.filter((q) => q !== c)
        this.settle(c, 'timeout')
      })
    }
    if (this.active.size < this.opts.capacity) return this.start(c)
    if (this.queue.length < this.opts.queueLimit) {
      this.queue.push(c)
      const col = this.opts.collapse
      if (col && this.queue.length > col.queueThreshold) this.collapse(col.recovery)
      return
    }
    this.settle(c, 'error')
  }

  private start(c: Call): void {
    this.active.add(c)
    this.busy.set(this.utilization)
    let factor = this.opts.slowdown ? this.opts.slowdown(this.utilization) : 1
    if (this.sim.now < this.slowUntil) factor *= this.slowFactor
    this.sim.schedule(this.opts.serviceTime() * factor, () => {
      if (!this.active.delete(c)) return // killed by collapse
      this.busy.set(this.utilization)
      this.settle(c, 'ok')
      const next = this.queue.shift()
      if (next) this.start(next)
    })
  }

  private settle(c: Call, outcome: Outcome): void {
    if (c.settled) return
    c.settled = true
    c.timeout?.cancel()
    c.done(outcome)
  }

  private collapse(recovery: number): void {
    this.state = 'down'
    const victims = [...this.active, ...this.queue]
    this.active.clear()
    this.queue = []
    this.busy.set(0)
    for (const c of victims) this.settle(c, 'error')
    this.sim.schedule(recovery, () => { this.state = 'up' })
  }
}

/** Instance work: spend `localTime`, then one upstream call; outcome is the upstream's. */
export function viaUpstream(sim: Sim, upstream: Upstream, localTime: () => number): Work {
  return (_req, finish) => {
    sim.schedule(localTime(), () => upstream.call(finish))
  }
}
