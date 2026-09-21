import type { Sim } from './engine'

/** Given the observed metric and current size, return the desired size. */
export type Policy = (metric: number, current: number) => number

/** Step policy: classic threshold-based scaling (AWS simple scaling). */
export function threshold(o: { up: number; down: number; step: number }): Policy {
  return (metric, current) => {
    if (metric > o.up) return current + o.step
    if (metric < o.down) return current - o.step
    return current
  }
}

/** Target tracking, k8s HPA style: desired = ceil(current * metric / target). */
export function targetTracking(o: { target: number; tolerance?: number }): Policy {
  const tol = o.tolerance ?? 0
  return (metric, current) => {
    const ratio = metric / o.target
    if (Math.abs(ratio - 1) <= tol) return current
    return Math.ceil(current * ratio)
  }
}

export interface Scalable {
  readonly size: number
  scaleTo(n: number): void
}

export interface ScalerOpts {
  /** Decision interval. */
  period: number
  /** How often the signal is sampled (defaults to `period`). */
  sampleInterval?: number
  /** Metric pipeline lag: decisions see the signal as it was this long ago. */
  metricDelay?: number
  /** Samples are averaged over this trailing window (defaults to `period`). */
  window?: number
  min: number
  max: number
  policy: Policy
  scaleUpCooldown?: number
  scaleDownCooldown?: number
  /** Scale-down uses the max desired size seen within this window (k8s HPA). */
  stabilizationWindow?: number
}

interface Sample { t: number; v: number }

/** A sampled feedback controller: signal → policy → target.scaleTo(). */
export class Autoscaler {
  /** Last metric value the policy saw. */
  metric = NaN
  /** Last desired size (after clamping and stabilization). */
  desired = NaN

  private samples: Sample[] = []
  private desiredHistory: Sample[] = []
  private lastUp = -Infinity
  private lastDown = -Infinity

  constructor(
    private sim: Sim,
    private target: Scalable,
    private signal: () => number,
    private opts: ScalerOpts,
  ) {}

  start(): void {
    this.sample()
    this.sim.schedule(this.opts.period, () => this.tick())
  }

  private get sampleInterval(): number { return this.opts.sampleInterval ?? this.opts.period }
  private get window(): number { return this.opts.window ?? this.opts.period }

  private sample(): void {
    this.takeSample()
    this.sim.schedule(this.sampleInterval, () => this.sample())
  }

  /** At most one sample per instant, so a tick coinciding with a sample sees fresh data. */
  private takeSample(): void {
    const last = this.samples[this.samples.length - 1]
    if (!last || last.t < this.sim.now) this.samples.push({ t: this.sim.now, v: this.signal() })
    const keepFrom = this.sim.now - (this.opts.metricDelay ?? 0) - 2 * this.window
    // Keep one sample older than the horizon so observe() can fall back to it.
    while (this.samples.length > 1 && this.samples[1].t <= keepFrom) this.samples.shift()
  }

  private observe(): number | undefined {
    const te = this.sim.now - (this.opts.metricDelay ?? 0)
    const inWindow = this.samples.filter((s) => s.t > te - this.window && s.t <= te)
    if (inWindow.length) return inWindow.reduce((a, s) => a + s.v, 0) / inWindow.length
    const older = this.samples.filter((s) => s.t <= te)
    return older.length ? older[older.length - 1].v : undefined
  }

  private tick(): void {
    this.sim.schedule(this.opts.period, () => this.tick())
    this.takeSample()
    const metric = this.observe()
    if (metric === undefined) return
    this.metric = metric

    const current = this.target.size
    const raw = this.opts.policy(metric, current)
    const clamped = Math.min(this.opts.max, Math.max(this.opts.min, raw))
    let desired = clamped

    const stab = this.opts.stabilizationWindow
    if (stab !== undefined) {
      this.desiredHistory.push({ t: this.sim.now, v: clamped })
      this.desiredHistory = this.desiredHistory.filter((d) => d.t > this.sim.now - stab)
      if (clamped < current) desired = Math.max(...this.desiredHistory.map((d) => d.v))
    }
    this.desired = desired

    if (desired > current) {
      if (this.sim.now - this.lastUp < (this.opts.scaleUpCooldown ?? 0)) return
      this.lastUp = this.sim.now
      this.target.scaleTo(desired)
    } else if (desired < current) {
      if (this.sim.now - this.lastDown < (this.opts.scaleDownCooldown ?? 0)) return
      this.lastDown = this.sim.now
      this.target.scaleTo(desired)
    }
  }
}
