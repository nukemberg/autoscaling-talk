import type { Cluster } from '../cluster'
import type { Sim } from '../engine'
import type { PodMetrics } from './metrics'

/**
 * Kubernetes HorizontalPodAutoscaler, per
 * https://kubernetes.io/docs/tasks/run-application/horizontal-pod-autoscale/#algorithm-details
 * and the default `behavior` block.
 */
export interface HpaOpts {
  /** targetAverageUtilization as a fraction. */
  target: number
  min: number
  max: number
  /** --horizontal-pod-autoscaler-sync-period (default 15 s). */
  syncPeriod?: number
  /** Ratio band around 1.0 that is ignored (default 0.1). */
  tolerance?: number
  /** Metric average window; metrics-server scrapes every 15 s. */
  metricWindow?: number
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
  /** Last recommendation after stabilization and rate limits. */
  desired = NaN

  private recommendations: Rec[] = []
  private changes: Rec[] = []          // (t, delta) of every scale we applied

  constructor(private sim: Sim, private cluster: Cluster, private metrics: PodMetrics, private opts: HpaOpts) {}

  private get o() {
    const o = this.opts
    return {
      syncPeriod: o.syncPeriod ?? 15, tolerance: o.tolerance ?? 0.1, metricWindow: o.metricWindow ?? 15,
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
    const o = this.o
    const now = this.sim.now
    const pods = this.cluster.instances.filter((i) => i.state !== 'terminated')
    const current = pods.length
    if (!current) return

    // Set aside not-yet-ready pods and pods with missing metrics.
    const withMetric: number[] = []
    let setAside = 0
    for (const p of pods) {
      const notYetReady = p.state !== 'ready' || (p.readySince ?? now) > now - o.initialReadinessDelay
      const v = notYetReady ? undefined : this.metrics.value(p, o.metricWindow)
      if (v === undefined) setAside++
      else withMetric.push(v)
    }
    if (!withMetric.length) return

    const avg = withMetric.reduce((a, b) => a + b, 0) / withMetric.length
    this.metric = avg
    const ratio = avg / this.opts.target
    if (Math.abs(ratio - 1) <= o.tolerance) {
      this.recommend(current)
      return
    }

    let desired: number
    if (ratio > 1) {
      // Scale up: set-aside pods assumed at 0% usage.
      const newRatio = (avg * withMetric.length) / (this.opts.target * current)
      if (Math.abs(newRatio - 1) <= o.tolerance || newRatio < 1) { this.recommend(current); return }
      desired = Math.ceil(current * newRatio)
    } else {
      // Scale down: set-aside pods assumed at 100% of target.
      const newRatio = (avg * withMetric.length + this.opts.target * setAside) / (this.opts.target * current)
      if (Math.abs(newRatio - 1) <= o.tolerance || newRatio > 1) { this.recommend(current); return }
      desired = Math.ceil(current * newRatio)
    }
    desired = Math.min(this.opts.max, Math.max(this.opts.min, desired))
    this.recommend(desired)
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
