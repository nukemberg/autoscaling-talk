import type { Cluster } from './cluster'
import type { Sim } from './engine'

export interface CostOpts {
  cluster: Cluster
  /** Price per instance per time unit. */
  instancePrice: number
  /** Additional spend rate (per time unit), integrated by sampling — e.g. upstream tier. */
  extraRate?: () => number
  sampleInterval?: number
}

/** Running bill: instance-time plus whatever else scaling drags along. */
export class Cost {
  private extra = 0
  private lastSample = 0

  constructor(private sim: Sim, private opts: CostOpts) {}

  /** Begin integrating `extraRate`; unnecessary when only instancePrice is used. */
  start(): void {
    this.lastSample = this.sim.now
    this.sample()
  }

  get instanceCost(): number { return this.opts.cluster.instanceTime * this.opts.instancePrice }
  get extraCost(): number { return this.extra }
  get total(): number { return this.instanceCost + this.extraCost }

  private sample(): void {
    const dt = this.sim.now - this.lastSample
    if (dt > 0 && this.opts.extraRate) this.extra += this.opts.extraRate() * dt
    this.lastSample = this.sim.now
    this.sim.schedule(this.opts.sampleInterval ?? 1, () => this.sample())
  }
}
