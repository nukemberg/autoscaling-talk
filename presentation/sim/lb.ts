import type { Sim } from './engine'
import type { Instance } from './instance'
import type { Request } from './types'

export interface LbOpts {
  policy?: 'round-robin' | 'least-conn'
  /**
   * When set, routability is refreshed only every `interval`: a freshly
   * booted instance waits for the next check to join, and a dead one keeps
   * getting traffic until the next check notices. Without it the LB sees
   * instance state live.
   */
  healthCheck?: {
    interval: number
    /** Consecutive failed checks before leaving rotation (default 1). */
    unhealthyAfter?: number
    /** Consecutive passed checks before rejoining (default 1). */
    healthyAfter?: number
  }
}

/** Routes requests to ready instances; forwards completions to `onDone`. */
export class LoadBalancer {
  onDone: (req: Request) => void = () => {}

  private pool: Instance[] = []
  private routable: Instance[] = []
  private rr = 0
  /** Consecutive check results per instance: +n passes, -n failures. */
  private streak = new Map<Instance, number>()

  constructor(private sim: Sim, private opts: LbOpts = {}) {
    if (opts.healthCheck) this.check(opts.healthCheck.interval)
  }

  get size(): number { return this.pool.length }
  get readyCount(): number { return this.ready().length }
  get instances(): readonly Instance[] { return this.pool }

  add(inst: Instance): void {
    inst.onDone = (r) => this.onDone(r)
    this.pool.push(inst)
  }

  remove(inst: Instance): void {
    this.pool = this.pool.filter((i) => i !== inst)
    this.routable = this.routable.filter((i) => i !== inst)
    this.streak.delete(inst)
  }

  handle(req: Request): void {
    const target = this.pick(this.ready())
    if (!target) {
      req.doneAt = this.sim.now
      req.outcome = 'rejected'
      this.onDone(req)
      return
    }
    target.handle(req)
  }

  private ready(): Instance[] {
    if (this.opts.healthCheck) return this.routable
    return this.pool.filter((i) => i.state === 'ready')
  }

  private pick(candidates: Instance[]): Instance | undefined {
    if (!candidates.length) return undefined
    if (this.opts.policy === 'least-conn') {
      return candidates.reduce((best, i) => (i.inFlight < best.inFlight ? i : best))
    }
    const target = candidates[this.rr % candidates.length]
    this.rr++
    return target
  }

  private check(interval: number): void {
    const hc = this.opts.healthCheck!
    const unhealthyAfter = hc.unhealthyAfter ?? 1, healthyAfter = hc.healthyAfter ?? 1
    const inRotation = new Set(this.routable)
    for (const i of this.pool) {
      const prev = this.streak.get(i) ?? 0
      const streak = i.healthy ? Math.max(1, prev + 1) : Math.min(-1, prev - 1)
      this.streak.set(i, streak)
      if (streak <= -unhealthyAfter) inRotation.delete(i)
      else if (streak >= healthyAfter) inRotation.add(i)
    }
    this.routable = this.pool.filter((i) => inRotation.has(i))
    this.sim.schedule(interval, () => this.check(interval))
  }
}
