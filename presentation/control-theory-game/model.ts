/**
 * Hot/Cold shower model — pure dead time.
 *
 * The knob sets a temperature; the water you feel is that setting *delayed by the pipe*
 * (plus a little smoothing so it isn't a hard step). No UI, no clock: step() advances one
 * fixed tick, so it's deterministic and unit-testable.
 */

export const T_MIN = 10
export const T_MAX = 50
/** 16 so that even the largest hidden offset (+MAX_OFFSET) puts the equilibrium knob at T_MIN, not below it. */
export const START_TEMP = 16

export const clamp = (v: number, lo = T_MIN, hi = T_MAX): number => Math.min(hi, Math.max(lo, v))

export interface ShowerOpts {
  /** Pipe delay: seconds between turning the knob and the water starting to respond. */
  delaySec: number
  /** Hidden knob→water offset (°): steady-state water = knob + offset. Lets the player feel the mapping instead of reading it. */
  offset?: number
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
  readonly offset: number
  knob: number
  water: number
  t = 0
  /** Knob history, newest last; length is held at delaySteps + 1. */
  private buf: number[]

  constructor(o: ShowerOpts) {
    this.stepSec = o.stepSec ?? 0.05
    this.delaySteps = Math.max(0, Math.round(o.delaySec / this.stepSec))
    this.smoothSec = o.smoothSec ?? 0.4
    this.offset = o.offset ?? 0
    this.water = o.startTemp ?? START_TEMP
    // Start in equilibrium: the knob sits wherever makes the water equal the start temperature.
    this.knob = clamp(this.water - this.offset)
    this.buf = [this.knob]
  }

  setKnob(v: number): void {
    this.knob = clamp(v)
  }

  step(): void {
    this.buf.push(this.knob)
    if (this.buf.length > this.delaySteps + 1) this.buf.shift()
    // Oldest entry in the buffer is the knob setting `delaySteps` ticks ago.
    const delayed = clamp(this.buf[0] + this.offset)
    const a = 1 - Math.exp(-this.stepSec / this.smoothSec)
    this.water += (delayed - this.water) * a
    this.t += this.stepSec
  }
}

/** Max hidden offset (°). Keeps every target reachable: target 24..42 needs knob 18..48 within 10..50. */
export const MAX_OFFSET = 6

/** Random hidden offset in [-MAX_OFFSET, MAX_OFFSET], on half-degree steps. */
export function randomOffset(rng: () => number = Math.random): number {
  return Math.round((rng() * 2 - 1) * MAX_OFFSET * 2) / 2
}

export const BAND = 1.5
export const ROUND_SEC = 30
const TARGET_MIN = 24
const TARGET_MAX = 42

/** Random target, always far enough from the start temperature that you have to move. */
export function randomTarget(rng: () => number = Math.random): number {
  return Math.round((TARGET_MIN + rng() * (TARGET_MAX - TARGET_MIN)) * 2) / 2
}

/** Water must stay in the band this long (s) to count as stable — then the target moves. */
export const STABLE_SEC = 2
/** A moved target is at least this far (°) from the previous one. */
export const MIN_JUMP = 6

/** Next target: random in range, at least MIN_JUMP away from the previous one. */
export function nextTarget(prev: number, rng: () => number = Math.random): number {
  for (let i = 0; i < 30; i++) {
    const t = Math.round((TARGET_MIN + rng() * (TARGET_MAX - TARGET_MIN)) * 2) / 2
    if (Math.abs(t - prev) >= MIN_JUMP) return t
  }
  // Deterministic fallback so a degenerate rng can't loop forever.
  return prev < (TARGET_MIN + TARGET_MAX) / 2 ? prev + 2 * MIN_JUMP : prev - 2 * MIN_JUMP
}

export interface RoundResult {
  /** Targets the player held steady for STABLE_SEC. */
  hits: number
  /** Times the water left the band after first reaching it (before settling). */
  lostBand: number
  /** Worst swing past a target after first reaching it (°), 0 if never. Not counted while still approaching. */
  overshoot: number
}

export class Round {
  elapsed = 0
  hits = 0
  /** Seconds the water has been continuously in the band for the current target. */
  stableSec = 0
  private lostBand = 0
  private maxOvershoot = 0
  private dev = 0
  private reached = false
  private wasIn = false

  constructor(
    public target: number,
    readonly band: number = BAND,
    readonly durationSec: number = ROUND_SEC,
    private readonly pickNext: (prev: number) => number = (p) => nextTarget(p),
  ) {}

  get done(): boolean {
    return this.elapsed >= this.durationSec
  }

  /** 0..1 progress towards the current target counting as stable. */
  get holdFraction(): number {
    return Math.min(1, this.stableSec / STABLE_SEC)
  }

  /** Advance the round. Returns true when the target just moved (the previous one was a hit). */
  update(water: number, dt: number): boolean {
    if (this.done) return false
    const inBand = Math.abs(water - this.target) <= this.band
    this.elapsed += dt
    if (this.reached && this.wasIn && !inBand) this.lostBand++
    if (inBand) this.reached = true
    // Overshoot only counts once the water has been in the band: before that it is still approaching,
    // and when the target moves away from the water that is the target's doing, not the player's.
    if (this.reached) this.dev = Math.max(this.dev, Math.abs(water - this.target))
    this.wasIn = inBand
    this.stableSec = inBand ? this.stableSec + dt : 0
    if (this.stableSec >= STABLE_SEC) {
      this.hits++
      this.maxOvershoot = Math.max(this.maxOvershoot, this.dev)
      this.target = this.pickNext(this.target)
      this.stableSec = 0
      this.dev = 0
      this.reached = false
      this.wasIn = false
      return true
    }
    return false
  }

  result(): RoundResult {
    return {
      hits: this.hits,
      lostBand: this.lostBand,
      // Include the in-progress target's swing too.
      overshoot: Math.round(Math.max(this.maxOvershoot, this.dev) * 10) / 10,
    }
  }
}
