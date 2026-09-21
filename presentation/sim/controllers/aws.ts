import type { Cluster } from '../cluster'
import type { Sim } from '../engine'
import type { PodMetrics } from './metrics'

/**
 * Amazon EC2 Auto Scaling policies, per
 * https://docs.aws.amazon.com/autoscaling/ec2/userguide/as-scaling-target-tracking.html
 * https://docs.aws.amazon.com/autoscaling/ec2/userguide/as-scaling-simple-step.html
 *
 * Common machinery: CloudWatch-style 1-minute datapoints aggregated over
 * instances that are InService and past their warm-up, alarms that need N
 * consecutive breaching datapoints, and instance warm-up semantics.
 */

interface Datapoint { t: number; v: number | undefined }

export interface CloudWatchOpts {
  /** Datapoint period (default 60 s). */
  period?: number
  /** Delay before a datapoint is visible to alarms (default 0). */
  metricDelay?: number
  /** Instance warm-up since InService (default 300 s, AWS default cooldown). */
  warmup?: number
}

/** Shared datapoint pipeline + warm-up bookkeeping. */
abstract class AwsPolicy {
  /** Latest visible datapoint. */
  metric = NaN
  desired = NaN
  protected datapoints: Datapoint[] = []

  constructor(protected sim: Sim, protected cluster: Cluster, protected metrics: PodMetrics, private cw: CloudWatchOpts) {}

  protected get period(): number { return this.cw.period ?? 60 }
  protected get warmup(): number { return this.cw.warmup ?? 300 }

  start(): void {
    this.sim.schedule(this.period, () => this.publish())
  }

  /** Instances counted in the aggregated metric: InService and warmed up. */
  protected warmed(at = this.sim.now) {
    return this.cluster.instances.filter((i) => i.state === 'ready' && (i.readySince ?? Infinity) + this.warmup <= at)
  }

  protected get anyWarming(): boolean {
    return this.cluster.instances.some((i) => i.state !== 'terminated' && !this.warmed().includes(i))
  }

  /** Last `n` datapoints all satisfy `breach`; missing data never breaches. */
  protected inAlarm(n: number, breach: (v: number) => boolean): boolean {
    if (this.datapoints.length < n) return false
    return this.datapoints.slice(-n).every((d) => d.v !== undefined && breach(d.v))
  }

  protected clamp(n: number, min: number, max: number): number {
    return Math.min(max, Math.max(min, n))
  }

  private publish(): void {
    this.sim.schedule(this.period, () => this.publish())
    const end = this.sim.now
    const pool = this.warmed(end)
    const vals = pool.map((i) => this.metrics.value(i, this.period, end)).filter((v): v is number => v !== undefined)
    const v = vals.length ? vals.reduce((a, b) => a + b, 0) / vals.length : undefined
    const dp = { t: end, v }
    this.sim.schedule(this.cw.metricDelay ?? 0, () => {
      this.datapoints.push(dp)
      if (this.datapoints.length > 60) this.datapoints.shift()
      if (v !== undefined) this.metric = v
      this.evaluate()
    })
  }

  /** Alarm evaluation on every new visible datapoint. */
  protected abstract evaluate(): void
}

// ---------------- target tracking ----------------

export interface AwsTargetTrackingOpts extends CloudWatchOpts {
  target: number
  min: number
  max: number
  /** AlarmHigh: consecutive datapoints above target (observed default 3). */
  highEvalPeriods?: number
  /** AlarmLow: consecutive datapoints below `lowFactor × target` (observed default 15). */
  lowEvalPeriods?: number
  lowFactor?: number
  disableScaleIn?: boolean
}

export class AwsTargetTracking extends AwsPolicy {
  constructor(sim: Sim, cluster: Cluster, metrics: PodMetrics, private opts: AwsTargetTrackingOpts) {
    super(sim, cluster, metrics, opts)
  }

  protected evaluate(): void {
    const o = this.opts
    const dp = this.datapoints[this.datapoints.length - 1].v
    if (dp === undefined) return
    const size = this.cluster.size

    if (this.inAlarm(o.highEvalPeriods ?? 3, (v) => v > o.target)) {
      // Needed capacity from the instances the metric actually describes; the
      // ones still warming up already count toward what has been ordered.
      const needed = this.clamp(Math.ceil(this.warmed().length * dp / o.target), o.min, o.max)
      this.desired = Math.max(needed, size)
      if (needed > size) this.cluster.scaleTo(needed)
      return
    }
    if (!o.disableScaleIn && this.inAlarm(o.lowEvalPeriods ?? 15, (v) => v < o.target * (o.lowFactor ?? 0.9))) {
      if (this.anyWarming) return              // scale-in blocked during scale-out warm-up
      const needed = this.clamp(Math.ceil(size * dp / o.target), o.min, o.max)
      this.desired = Math.min(needed, size)
      if (needed < size) this.cluster.scaleTo(needed)
      return
    }
    this.desired = size
  }
}

// ---------------- step scaling ----------------

export interface Step { lower: number; upper: number; adjust: number; percent: boolean }

/** "lower-upper:adjust, ..." — bounds relative to the threshold, upper may be empty (∞), adjust like +10%, -1, 0. */
export function parseSteps(spec: string): Step[] {
  return spec.split(',').map((s) => s.trim()).filter(Boolean).map((s) => {
    const m = /^([\d.]+)-([\d.]*):([+-]?[\d.]+)(%?)$/.exec(s)
    if (!m) throw new Error(`bad step "${s}"; expected lower-upper:adjust e.g. 10-20:+10%`)
    return { lower: Number(m[1]), upper: m[2] === '' ? Infinity : Number(m[2]), adjust: Number(m[3]), percent: m[4] === '%' }
  })
}

/** AWS rounding for percent adjustments: |x| < 1 → ±1, otherwise toward zero. */
export function roundAdjustment(x: number): number {
  if (x === 0) return 0
  if (Math.abs(x) < 1) return Math.sign(x)
  return Math.trunc(x)
}

function stepAdjust(steps: Step[], breach: number, capacity: number): number {
  const step = steps.find((s) => breach >= s.lower && breach < s.upper)
  if (!step) return 0
  return step.percent ? roundAdjustment(capacity * step.adjust / 100) : step.adjust
}

export interface AwsStepScalingOpts extends CloudWatchOpts {
  min: number
  max: number
  outThreshold: number
  outSteps: string
  outEvalPeriods?: number
  inThreshold: number
  inSteps: string
  inEvalPeriods?: number
}

export class AwsStepScaling extends AwsPolicy {
  private outSteps: Step[]
  private inSteps: Step[]

  constructor(sim: Sim, cluster: Cluster, metrics: PodMetrics, private opts: AwsStepScalingOpts) {
    super(sim, cluster, metrics, opts)
    this.outSteps = parseSteps(opts.outSteps)
    this.inSteps = parseSteps(opts.inSteps)
  }

  protected evaluate(): void {
    const o = this.opts
    const dp = this.datapoints[this.datapoints.length - 1].v
    if (dp === undefined) return
    const size = this.cluster.size

    if (this.inAlarm(o.outEvalPeriods ?? 1, (v) => v > o.outThreshold)) {
      // Adjustment is relative to *current* (warmed) capacity; desired may already be ahead of it.
      const current = this.warmed().length
      const needed = this.clamp(current + stepAdjust(this.outSteps, dp - o.outThreshold, current), o.min, o.max)
      this.desired = Math.max(needed, size)
      if (needed > size) this.cluster.scaleTo(needed)
      return
    }
    if (this.inAlarm(o.inEvalPeriods ?? 1, (v) => v < o.inThreshold)) {
      if (this.anyWarming) return
      const needed = this.clamp(size + stepAdjust(this.inSteps, o.inThreshold - dp, size), o.min, o.max)
      this.desired = Math.min(needed, size)
      if (needed < size) this.cluster.scaleTo(needed)
      return
    }
    this.desired = size
  }
}

// ---------------- simple scaling ----------------

/** "+2", "-1", "+50%", "-10%". */
export function parseAdjust(spec: string): { adjust: number; percent: boolean } {
  const m = /^([+-]?[\d.]+)(%?)$/.exec(spec.trim())
  if (!m) throw new Error(`bad adjustment "${spec}"; expected e.g. +2 or -10%`)
  return { adjust: Number(m[1]), percent: m[2] === '%' }
}

export interface AwsSimpleScalingOpts extends CloudWatchOpts {
  min: number
  max: number
  /** Default cooldown 300 s: no scaling activity until it expires. */
  cooldown?: number
  outThreshold: number
  outAdjust: string
  outEvalPeriods?: number
  inThreshold: number
  inAdjust: string
  inEvalPeriods?: number
}

export class AwsSimpleScaling extends AwsPolicy {
  private lastAction = -Infinity

  constructor(sim: Sim, cluster: Cluster, metrics: PodMetrics, private opts: AwsSimpleScalingOpts) {
    super(sim, cluster, metrics, { ...opts, warmup: 0 }) // simple scaling has no warm-up concept
  }

  private apply(spec: string): void {
    const { adjust, percent } = parseAdjust(spec)
    const size = this.cluster.size
    const delta = percent ? roundAdjustment(size * adjust / 100) : adjust
    const desired = this.clamp(size + delta, this.opts.min, this.opts.max)
    this.desired = desired
    if (desired !== size) {
      this.cluster.scaleTo(desired)
      this.lastAction = this.sim.now
    }
  }

  protected evaluate(): void {
    const o = this.opts
    this.desired = this.cluster.size
    if (this.sim.now - this.lastAction < (o.cooldown ?? 300)) return
    if (this.inAlarm(o.outEvalPeriods ?? 1, (v) => v > o.outThreshold)) this.apply(o.outAdjust)
    else if (this.inAlarm(o.inEvalPeriods ?? 1, (v) => v < o.inThreshold)) this.apply(o.inAdjust)
  }
}
