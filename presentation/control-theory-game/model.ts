/**
 * Hot/Cold shower model — pure dead time.
 *
 * The knob sets a temperature; the water you feel is that setting *delayed by the pipe*
 * (plus a little smoothing so it isn't a hard step). No UI, no clock: step() advances one
 * fixed tick, so it's deterministic and unit-testable.
 */

export const T_MIN = 10
export const T_MAX = 50
export const START_TEMP = 15

export const clamp = (v: number, lo = T_MIN, hi = T_MAX): number => Math.min(hi, Math.max(lo, v))

export interface ShowerOpts {
  /** Pipe delay: seconds between turning the knob and the water starting to respond. */
  delaySec: number
  /** First-order smoothing time constant (s) applied after the delay. */
  smoothSec?: number
  /** Fixed simulation tick (s). */
  stepSec?: number
  startTemp?: number
}

export class Shower {
  readonly stepSec: number
  readonly delaySteps: number
  readonly smoothSec: number
  knob: number
  water: number
  t = 0
  /** Knob history, newest last; length is held at delaySteps + 1. */
  private buf: number[]

  constructor(o: ShowerOpts) {
    this.stepSec = o.stepSec ?? 0.05
    this.delaySteps = Math.max(0, Math.round(o.delaySec / this.stepSec))
    this.smoothSec = o.smoothSec ?? 0.4
    this.knob = this.water = o.startTemp ?? START_TEMP
    this.buf = [this.knob]
  }

  setKnob(v: number): void {
    this.knob = clamp(v)
  }

  step(): void {
    this.buf.push(this.knob)
    if (this.buf.length > this.delaySteps + 1) this.buf.shift()
    // Oldest entry in the buffer is the knob setting `delaySteps` ticks ago.
    const delayed = this.buf[0]
    const a = 1 - Math.exp(-this.stepSec / this.smoothSec)
    this.water += (delayed - this.water) * a
    this.t += this.stepSec
  }
}

export const BAND = 1.5
export const ROUND_SEC = 30
const TARGET_MIN = 24
const TARGET_MAX = 42

/** Random target, always far enough from the start temperature that you have to move. */
export function randomTarget(rng: () => number = Math.random): number {
  return Math.round((TARGET_MIN + rng() * (TARGET_MAX - TARGET_MIN)) * 2) / 2
}

export interface RoundResult {
  /** % of the round the water was inside the comfort band. */
  inBandPct: number
  /** Times the water left the band after first reaching it. */
  lostBand: number
  /** Highest the water got above the target (0 if it never overshot). */
  overshoot: number
}

export class Round {
  elapsed = 0
  private inBandSec = 0
  private lostBand = 0
  private peak = -Infinity
  private reached = false
  private wasIn = false

  constructor(
    readonly target: number,
    readonly band: number = BAND,
    readonly durationSec: number = ROUND_SEC,
  ) {}

  get done(): boolean {
    return this.elapsed >= this.durationSec
  }

  update(water: number, dt: number): void {
    if (this.done) return
    const inBand = Math.abs(water - this.target) <= this.band
    this.elapsed += dt
    if (inBand) this.inBandSec += dt
    if (this.reached && this.wasIn && !inBand) this.lostBand++
    if (inBand) this.reached = true
    this.wasIn = inBand
    this.peak = Math.max(this.peak, water)
  }

  result(): RoundResult {
    return {
      inBandPct: this.elapsed ? Math.round((100 * this.inBandSec) / this.elapsed) : 0,
      lostBand: this.lostBand,
      overshoot: Math.max(0, Math.round((this.peak - this.target) * 10) / 10),
    }
  }
}
