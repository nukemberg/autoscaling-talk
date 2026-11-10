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

/** Number of lag stages in the chain. Three gives a clear S-curve (slow start, then faster) without a long tail. */
export const STAGES = 3

export interface ShowerOpts {
  /** Lag: mean delay (s) between turning the knob and the water catching up. 0 = instant. */
  delaySec: number
  /** Hidden knob→water offset (°): steady-state water = knob + offset. Lets the player feel the mapping instead of reading it. */
  offset?: number
  /** Fixed simulation tick (s). */
  stepSec?: number
  startTemp?: number
}

/**
 * Hot/Cold shower: the knob drives a chain of STAGES first-order lags, each with time constant
 * delaySec / STAGES, so the *mean* delay is delaySec. The water is the last stage.
 *
 * The water starts responding on the very first tick (rate ∝ error), but only barely: the
 * downstream stages have to fill first, so the effective gain ramps up — slow start, S-curve,
 * smooth settle, never an overshoot. Every knob move still arrives late, however you move the
 * knob afterwards (linear: no reset on re-adjusting), which is what makes chasing your own last
 * move fail.
 */
export class Shower {
  readonly stepSec: number
  readonly delaySec: number
  readonly offset: number
  knob: number
  water: number
  t = 0
  private stages: number[]
  private readonly a: number

  constructor(o: ShowerOpts) {
    this.stepSec = o.stepSec ?? 0.05
    this.delaySec = Math.max(0, o.delaySec)
    this.offset = o.offset ?? 0
    this.water = o.startTemp ?? START_TEMP
    // Start in equilibrium: the knob sits wherever makes the water equal the start temperature.
    this.knob = clamp(this.water - this.offset)
    this.stages = Array<number>(STAGES).fill(this.water)
    const tau = this.delaySec / STAGES
    this.a = tau > 0 ? 1 - Math.exp(-this.stepSec / tau) : 1
  }

  setKnob(v: number): void {
    this.knob = clamp(v)
  }

  step(): void {
    let input = clamp(this.knob + this.offset)
    for (let i = 0; i < STAGES; i++) {
      // Each stage follows the previous stage's already-updated value, so a change reaches the
      // water on the very first tick (just not by much) rather than one stage per tick.
      this.stages[i] += (input - this.stages[i]) * this.a
      input = this.stages[i]
    }
    this.water = this.stages[STAGES - 1]
    this.t += this.stepSec
  }
}

/** Max hidden offset (°). Keeps every target reachable: target 24..42 needs knob 18..48 within 10..50. */
export const MAX_OFFSET = 6

/** Random hidden offset in [-MAX_OFFSET, MAX_OFFSET], on half-degree steps. */
export function randomOffset(rng: () => number = Math.random): number {
  return Math.round((rng() * 2 - 1) * MAX_OFFSET * 2) / 2
}

export const BAND = 1.2
export const ROUND_SEC = 30
const TARGET_MIN = 24
const TARGET_MAX = 42

/** Random target, always far enough from the start temperature that you have to move. */
export function randomTarget(rng: () => number = Math.random): number {
  return Math.round((TARGET_MIN + rng() * (TARGET_MAX - TARGET_MIN)) * 2) / 2
}

/** Water must stay in the band this long (s) to count as stable — then the target moves. */
export const STABLE_SEC = 2
/** Time (s) allowed per target before it moves on anyway: scales with the lag so long lags stay playable. */
export const DEADLINE_FLOOR = 5
export const DEADLINE_PER_LAG = 2.0
export const targetDeadline = (delaySec: number): number => Math.max(DEADLINE_FLOOR, DEADLINE_PER_LAG * delaySec)

export type RoundEvent = 'hit' | 'miss'

/** A moved target is at least this far (°) from the previous one. */
export const MIN_JUMP = 8

/** Next target: random in range, at least MIN_JUMP away from the previous one. */
export function nextTarget(prev: number, rng: () => number = Math.random): number {
  for (let i = 0; i < 30; i++) {
    const t = Math.round((TARGET_MIN + rng() * (TARGET_MAX - TARGET_MIN)) * 2) / 2
    if (Math.abs(t - prev) >= MIN_JUMP) return t
  }
  // Deterministic fallback so a degenerate rng can't loop forever: jump to the far end of the range
  // (always >= MIN_JUMP away, since the range midpoint is 9 from either end).
  return prev < (TARGET_MIN + TARGET_MAX) / 2 ? TARGET_MAX : TARGET_MIN
}

export interface RoundResult {
  /** Targets the player held steady for STABLE_SEC. */
  hits: number
  /** Targets that ran out of time before you held them. */
  misses: number
  /** Times the water left the band after first reaching it (before settling). */
  lostBand: number
  /** Worst swing past a target after first reaching it (°), 0 if never. Not counted while still approaching. */
  overshoot: number
}

export class Round {
  elapsed = 0
  hits = 0
  misses = 0
  /** Seconds the water has been continuously in the band for the current target. */
  stableSec = 0
  /** Seconds spent on the current target. */
  targetSec = 0
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
    /** Time allowed per target (s); Infinity = no deadline. */
    readonly deadlineSec: number = Infinity,
  ) {}

  get done(): boolean {
    return this.elapsed >= this.durationSec
  }

  /** 0..1 progress towards the current target counting as stable. */
  get holdFraction(): number {
    return Math.min(1, this.stableSec / STABLE_SEC)
  }

  /** 1 → plenty of time left on this target, 0 → about to move on. */
  get timeLeftFraction(): number {
    return Number.isFinite(this.deadlineSec) ? Math.max(0, 1 - this.targetSec / this.deadlineSec) : 1
  }

  /** Advance the round. Returns 'hit' / 'miss' when the target just moved (and why), else null. */
  update(water: number, dt: number): RoundEvent | null {
    if (this.done) return null
    const inBand = Math.abs(water - this.target) <= this.band
    this.elapsed += dt
    this.targetSec += dt
    if (this.reached && this.wasIn && !inBand) this.lostBand++
    if (inBand) this.reached = true
    // Overshoot only counts once the water has been in the band: before that it is still approaching,
    // and when the target moves away from the water that is the target's doing, not the player's.
    if (this.reached) this.dev = Math.max(this.dev, Math.abs(water - this.target))
    this.wasIn = inBand
    this.stableSec = inBand ? this.stableSec + dt : 0
    if (this.stableSec >= STABLE_SEC) {
      this.hits++
      this.advance()
      return 'hit'
    }
    // Out of time — unless you're mid-hold in the band, in which case you get to finish it.
    if (this.targetSec >= this.deadlineSec && this.stableSec === 0) {
      this.misses++
      this.advance()
      return 'miss'
    }
    return null
  }

  private advance(): void {
    this.maxOvershoot = Math.max(this.maxOvershoot, this.dev)
    this.target = this.pickNext(this.target)
    this.stableSec = 0
    this.targetSec = 0
    this.dev = 0
    this.reached = false
    this.wasIn = false
  }

  result(): RoundResult {
    return {
      hits: this.hits,
      misses: this.misses,
      lostBand: this.lostBand,
      // Include the in-progress target's swing too.
      overshoot: Math.round(Math.max(this.maxOvershoot, this.dev) * 10) / 10,
    }
  }
}
