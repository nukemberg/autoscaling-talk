import type { Cluster } from '../cluster'
import type { Sim } from '../engine'
import type { Instance } from '../instance'

export interface PodMetricsOpts {
  /** How often each instance's reported cpu is scraped. */
  sampleInterval: number
  /** The metrics agent: what an instance reports. Default: `inst.cpu`. */
  read?: (inst: Instance) => number
}

interface Sample { t: number; v: number }

/** Per-instance cpu scrape history — what metrics-server / CloudWatch would hold. */
export class PodMetrics {
  private samples = new Map<Instance, Sample[]>()
  private keep: number

  constructor(private sim: Sim, private cluster: Cluster, private opts: PodMetricsOpts) {
    this.keep = 20 * 60 // enough history for a 15-minute AWS scale-in alarm plus delay
  }

  start(): void {
    this.scrape()
  }

  /** Mean of samples in (at − window, at], or undefined if none. */
  value(inst: Instance, window: number, at = this.sim.now): number | undefined {
    const s = this.samples.get(inst)
    if (!s) return undefined
    let sum = 0, n = 0
    for (const x of s) if (x.t > at - window && x.t <= at) { sum += x.v; n++ }
    return n ? sum / n : undefined
  }

  private scrape(): void {
    const now = this.sim.now
    for (const inst of this.cluster.instances) {
      if (inst.state !== 'ready') continue
      let s = this.samples.get(inst)
      if (!s) this.samples.set(inst, (s = []))
      s.push({ t: now, v: this.opts.read ? this.opts.read(inst) : inst.cpu })
      while (s.length && s[0].t < now - this.keep) s.shift()
    }
    for (const inst of this.samples.keys()) if (inst.state === 'terminated') this.samples.delete(inst)
    this.sim.schedule(this.opts.sampleInterval, () => this.scrape())
  }
}
