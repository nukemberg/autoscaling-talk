import type { Cluster } from '../cluster'
import type { Sim } from '../engine'
import type { Instance } from '../instance'

/**
 * What the metrics agent reads off an instance, and how to turn scrapes back into a utilization:
 * - `counter`: a cumulative, monotone busy-seconds counter (like cgroup `cpu.stat` usage_usec or
 *   Node's `eventLoopUtilization()`). `value()` is its rate over the window — the honest
 *   time-average, however spiky the underlying occupancy is (e.g. a single core that is only
 *   ever 0% or 100% busy at any instant).
 * - `gauge`: an instantaneous level. `value()` is the mean of the point samples in the window.
 *   Point-sampling is biased/noisy for spiky signals, so this exists only for tests that dictate
 *   a flat per-pod reading directly.
 */
export type MetricSource =
  | { kind: 'counter'; read: (inst: Instance) => number }
  | { kind: 'gauge'; read: (inst: Instance) => number }

export interface PodMetricsOpts {
  /** How often each instance is scraped. */
  sampleInterval: number
  /** Default: the instance's cumulative reported CPU (`inst.cpuSeconds`), rate-computed. */
  source?: MetricSource
}

interface Sample { t: number; v: number }

const cpuCounter: MetricSource = { kind: 'counter', read: (inst) => inst.cpuSeconds }

/** Per-instance cpu scrape history — what metrics-server / CloudWatch would hold. */
export class PodMetrics {
  private samples = new Map<Instance, Sample[]>()
  private keep: number
  private source: MetricSource

  constructor(private sim: Sim, private cluster: Cluster, private opts: PodMetricsOpts) {
    this.keep = 20 * 60 // enough history for a 15-minute AWS scale-in alarm plus delay
    this.source = opts.source ?? cpuCounter
  }

  start(): void {
    this.scrape()
  }

  /**
   * Utilization over (at − window, at], or undefined if there isn't enough data.
   *
   * Counter: (v_last − v_base) / (t_last − t_base), where `last` is the newest sample ≤ at and
   * `base` is the newest sample ≤ at − window (so the rate spans the whole window when scrapes
   * line up with it), or the oldest sample still in the window if history doesn't reach back
   * that far. Needs two distinct scrapes: with only one there is no delta — the same reason
   * metrics-server reports nothing for a pod until its second scrape — so that's undefined too.
   *
   * Gauge: mean of the samples in the window; undefined if there are none.
   */
  value(inst: Instance, window: number, at = this.sim.now): number | undefined {
    const s = this.samples.get(inst)
    if (!s) return undefined
    if (this.source.kind === 'gauge') {
      let sum = 0, n = 0
      for (const x of s) if (x.t > at - window && x.t <= at) { sum += x.v; n++ }
      return n ? sum / n : undefined
    }
    let base: Sample | undefined, last: Sample | undefined
    for (const x of s) {
      if (x.t > at) break
      if (x.t <= at - window || !base) base = x
      last = x
    }
    if (!base || !last || last.t <= base.t || last.t <= at - window) return undefined
    return (last.v - base.v) / (last.t - base.t)
  }

  /**
   * The single freshest reading — what a client asking "what's the current
   * value" gets back, with no caller-chosen averaging window. This is how
   * real HPA reads metrics-server: it doesn't average history itself, it
   * just takes whatever metrics-server's own latest computation is.
   *
   * Counter: rate between the two most recent scrapes ≤ at (metrics-server
   * computes its own rate internally between its last two kubelet scrapes;
   * this mirrors that, using our own scrape cadence). Needs two distinct
   * scrapes, same as `value()`. Gauge: the single most recent sample's raw
   * value, not blended with older ones.
   */
  latest(inst: Instance, at = this.sim.now): number | undefined {
    const s = this.samples.get(inst)
    if (!s) return undefined
    let prev: Sample | undefined, last: Sample | undefined
    for (const x of s) {
      if (x.t > at) break
      prev = last
      last = x
    }
    if (!last) return undefined
    if (this.source.kind === 'gauge') return last.v
    if (!prev || last.t <= prev.t) return undefined
    return (last.v - prev.v) / (last.t - prev.t)
  }

  private scrape(): void {
    const now = this.sim.now
    for (const inst of this.cluster.instances) {
      if (inst.state !== 'ready') continue
      let s = this.samples.get(inst)
      if (!s) this.samples.set(inst, (s = []))
      s.push({ t: now, v: this.source.read(inst) })
      while (s.length && s[0].t < now - this.keep) s.shift()
    }
    for (const inst of this.samples.keys()) if (inst.state === 'terminated') this.samples.delete(inst)
    this.sim.schedule(this.opts.sampleInterval, () => this.scrape())
  }
}
