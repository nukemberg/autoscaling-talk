import type { Cluster } from '../cluster'
import type { Sim } from '../engine'
import type { Instance } from '../instance'
import type { PodMetrics } from './metrics'

/**
 * Kubernetes HorizontalPodAutoscaler, per
 * https://kubernetes.io/docs/tasks/run-application/horizontal-pod-autoscale/#algorithm-details
 * and the default `behavior` block.
 */
export interface HpaMetric {
  metrics: PodMetrics
  target: number
  /** For diagnostics/tests only — not used in the scaling math itself. */
  id: string
  kind: 'utilization' | 'absolute'
}

export interface HpaOpts {
  metrics: HpaMetric[]
  min: number
  max: number
  /** --horizontal-pod-autoscaler-sync-period (default 15 s). */
  syncPeriod?: number
  /** Ratio band around 1.0 that is ignored (default 0.1). */
  tolerance?: number
  /** --horizontal-pod-autoscaler-initial-readiness-delay (default 30 s): pods ready for less are set aside. */
  initialReadinessDelay?: number
  /** scaleDown.stabilizationWindowSeconds (default 300). */
  downStabilization?: number
  /** scaleUp policies: Pods 4 / Percent 100 per 15 s, selectPolicy Max. */
  scaleUpPods?: number
  scaleUpPercent?: number
  scaleUpPeriod?: number
  /** scaleDown policy: Percent 100 per 15 s. */
  scaleDownPercent?: number
  scaleDownPeriod?: number
}

interface Rec { t: number; v: number }

export class Hpa {
  /** Average utilization over pods that had metrics (what the HPA status reports). */
  metric = NaN
  /** Kind of whichever metric last drove `metric` — tells a chart whether to ×100. */
  metricKind: 'utilization' | 'absolute' = 'utilization'
  /** Last recommendation after stabilization and rate limits. */
  desired = NaN

  private recommendations: Rec[] = []
  private changes: Rec[] = []          // (t, delta) of every scale we applied

  constructor(private sim: Sim, private cluster: Cluster, private opts: HpaOpts) {}

  private get o() {
    const o = this.opts
    return {
      syncPeriod: o.syncPeriod ?? 15, tolerance: o.tolerance ?? 0.1,
      initialReadinessDelay: o.initialReadinessDelay ?? 30, downStabilization: o.downStabilization ?? 300,
      scaleUpPods: o.scaleUpPods ?? 4, scaleUpPercent: o.scaleUpPercent ?? 100, scaleUpPeriod: o.scaleUpPeriod ?? 15,
      scaleDownPercent: o.scaleDownPercent ?? 100, scaleDownPeriod: o.scaleDownPeriod ?? 15,
    }
  }

  start(): void {
    this.sim.schedule(this.o.syncPeriod, () => this.sync())
  }

  private sync(): void {
    this.sim.schedule(this.o.syncPeriod, () => this.sync())
    const pods = this.cluster.instances.filter((i) => i.state !== 'terminated')
    const current = pods.length
    if (!current) return

    let best: { desired: number; metric: number; kind: 'utilization' | 'absolute' } | undefined
    for (const m of this.opts.metrics) {
      const r = this.desiredForMetric(m, pods, current)
      if (r && (!best || r.desired > best.desired)) best = r
    }
    if (!best) return // no toggled metric had data from any pod this tick

    this.metric = best.metric
    this.metricKind = best.kind
    this.recommend(best.desired)
  }

  /** One metric's contribution to the multi-metric max — real HPA computes desired PER
   *  metric (including its own set-aside/tolerance handling) and takes the largest. Returns
   *  undefined when this metric had no data from any pod this tick (real HPA skips a metric
   *  it can't retrieve rather than failing the whole sync). */
  private desiredForMetric(m: HpaMetric, pods: readonly Instance[], current: number): { desired: number; metric: number; kind: 'utilization' | 'absolute' } | undefined {
    const o = this.o
    const now = this.sim.now
    const withMetric: number[] = []
    let setAside = 0
    for (const p of pods) {
      const notYetReady = p.state !== 'ready' || (p.readySince ?? now) > now - o.initialReadinessDelay
      const v = notYetReady ? undefined : m.metrics.latest(p)
      if (v === undefined) setAside++
      else withMetric.push(v)
    }
    if (!withMetric.length) return undefined
    if (m.target <= 0) return undefined // degenerate target: skip rather than divide by zero

    const avg = withMetric.reduce((a, b) => a + b, 0) / withMetric.length
    const ratio = avg / m.target
    if (Math.abs(ratio - 1) <= o.tolerance) return { desired: current, metric: avg, kind: m.kind }

    let desired: number
    if (ratio > 1) {
      const newRatio = (avg * withMetric.length) / (m.target * current)
      if (Math.abs(newRatio - 1) <= o.tolerance || newRatio < 1) return { desired: current, metric: avg, kind: m.kind }
      desired = Math.ceil(current * newRatio)
    } else {
      const newRatio = (avg * withMetric.length + m.target * setAside) / (m.target * current)
      if (Math.abs(newRatio - 1) <= o.tolerance || newRatio > 1) return { desired: current, metric: avg, kind: m.kind }
      desired = Math.ceil(current * newRatio)
    }
    return { desired: Math.min(this.opts.max, Math.max(this.opts.min, desired)), metric: avg, kind: m.kind }
  }

  /** Record the recommendation, stabilize, rate-limit, apply. */
  private recommend(rec: number): void {
    const o = this.o
    const now = this.sim.now
    const current = this.cluster.size
    this.recommendations.push({ t: now, v: rec })
    this.recommendations = this.recommendations.filter((r) => r.t > now - Math.max(o.downStabilization, 1))

    let desired = rec
    if (rec < current) desired = Math.max(...this.recommendations.map((r) => r.v)) // downscale stabilization

    if (desired > current) {
      const start = this.replicasAt(now - o.scaleUpPeriod)
      const limit = Math.max(start + o.scaleUpPods, Math.floor(start * (1 + o.scaleUpPercent / 100)))
      desired = Math.min(desired, Math.max(limit, current))
    } else if (desired < current) {
      const start = this.replicasAt(now - o.scaleDownPeriod)
      const limit = Math.ceil(start * (1 - o.scaleDownPercent / 100))
      desired = Math.max(desired, Math.min(limit, current))
    }
    this.desired = desired
    if (desired !== current) {
      this.changes.push({ t: now, v: desired - current })
      this.changes = this.changes.filter((c) => c.t > now - 1800)
      this.cluster.scaleTo(desired)
    }
  }

  /** Replica count at time t, reconstructed from our own scale events. */
  private replicasAt(t: number): number {
    let n = this.cluster.size
    for (const c of this.changes) if (c.t > t) n -= c.v
    return n
  }
}
