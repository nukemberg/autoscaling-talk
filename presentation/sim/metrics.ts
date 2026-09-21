import type { EventHandle, Sim } from './engine'

/** Sample statistics over discrete observations (e.g. request latencies). */
export class Tally {
  private values: number[] = []
  private sorted = true

  add(v: number): void {
    if (this.values.length && v < this.values[this.values.length - 1]) this.sorted = false
    this.values.push(v)
  }

  reset(): void {
    this.values = []
    this.sorted = true
  }

  get count(): number { return this.values.length }

  get mean(): number {
    if (!this.values.length) return NaN
    let s = 0
    for (const v of this.values) s += v
    return s / this.values.length
  }

  get min(): number { return this.values.length ? Math.min(...this.values) : NaN }
  get max(): number { return this.values.length ? Math.max(...this.values) : NaN }

  /** Nearest-rank percentile, p in [0, 1]. */
  percentile(p: number): number {
    const n = this.values.length
    if (!n) return NaN
    if (!this.sorted) {
      this.values.sort((a, b) => a - b)
      this.sorted = true
    }
    const rank = Math.max(1, Math.ceil(p * n))
    return this.values[rank - 1]
  }
}

/** A level that changes over time (queue depth, instance count); mean weighted by duration. */
export class TimeWeighted {
  private area = 0
  private since: number
  private current: number

  constructor(private sim: Sim, initial: number) {
    this.current = initial
    this.since = sim.now
  }

  set(v: number): void {
    this.area += this.current * (this.sim.now - this.since)
    this.since = this.sim.now
    this.current = v
  }

  get value(): number { return this.current }

  get mean(): number {
    const elapsed = this.sim.now
    if (elapsed === 0) return this.current
    return (this.area + this.current * (this.sim.now - this.since)) / elapsed
  }
}

export type Probe = () => number

/** Periodically samples probes into aligned arrays, ready for uPlot. */
export class Recorder {
  readonly t: number[] = []
  readonly series: Record<string, number[]> = {}
  readonly names: string[]
  private handle?: EventHandle

  constructor(private sim: Sim, private period: number, private probes: Record<string, Probe>) {
    this.names = Object.keys(probes)
    for (const n of this.names) this.series[n] = []
  }

  start(): void {
    this.sample()
  }

  stop(): void {
    this.handle?.cancel()
    this.handle = undefined
  }

  /** [t, series0, series1, ...] in probe order — uPlot's data shape. */
  toUPlot(): number[][] {
    return [this.t, ...this.names.map((n) => this.series[n])]
  }

  private sample(): void {
    this.t.push(this.sim.now)
    for (const n of this.names) this.series[n].push(this.probes[n]())
    this.handle = this.sim.schedule(this.period, () => this.sample())
  }
}
