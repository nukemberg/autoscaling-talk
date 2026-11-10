import { describe, expect, test } from 'vitest'
import { BAND, MAX_OFFSET, MIN_JUMP, nextTarget, randomOffset, randomTarget, Round, Shower, START_TEMP, STABLE_SEC, T_MAX, T_MIN } from './model'

// Tiny smoothing so the water tracks the (delayed) knob almost exactly.
const sharp = (delaySec: number, offset = 0) => new Shower({ delaySec, smoothSec: 1e-6, offset })

/** Step the knob by `delta` from equilibrium and return the water trace (one entry per tick). */
function stepResponse(delaySec: number, delta = 10, seconds = delaySec * 8 + 5, offset = 0): { water: number[]; dt: number } {
  const s = new Shower({ delaySec, offset })
  s.setKnob(s.knob + delta)
  const water: number[] = []
  for (let i = 0; i < seconds / s.stepSec; i++) {
    s.step()
    water.push(s.water)
  }
  return { water, dt: s.stepSec }
}

describe('Shower', () => {
  test('responds on the very first tick, but only barely', () => {
    const { water } = stepResponse(3)
    expect(water[0]).toBeGreaterThan(START_TEMP) // immediate...
    expect(water[0] - START_TEMP).toBeLessThan(0.01) // ...but negligible
  })

  test('slow start: the rate of change keeps rising until the middle of the S-curve', () => {
    const { water, dt } = stepResponse(3)
    const rate = (k: number) => (water[k + 1] - water[k]) / dt
    expect(rate(10)).toBeGreaterThan(rate(1))
    expect(rate(30)).toBeGreaterThan(rate(10))
    expect(rate(30)).toBeGreaterThan(rate(400)) // and the late tail is slow again
  })

  test('approaches the setting monotonically and never overshoots', () => {
    const { water } = stepResponse(3, 10)
    for (let i = 1; i < water.length; i++) expect(water[i]).toBeGreaterThanOrEqual(water[i - 1])
    expect(Math.max(...water)).toBeLessThanOrEqual(START_TEMP + 10 + 1e-9)
    expect(water.at(-1)).toBeCloseTo(START_TEMP + 10, 1)
  })

  test('mean delay of a step response equals delaySec', () => {
    for (const delay of [1, 3, 8]) {
      const { water, dt } = stepResponse(delay, 10, delay * 12)
      // mean delay = integral of (1 - normalised response)
      const mean = water.reduce((sum, w) => sum + (1 - (w - START_TEMP) / 10) * dt, 0)
      expect(Math.abs(mean - delay) / delay).toBeLessThan(0.08)
    }
  })

  test('longer lag means a later response', () => {
    const half = (d: number) => {
      const { water, dt } = stepResponse(d, 10)
      return (water.findIndex((w) => w - START_TEMP >= 5) + 1) * dt
    }
    expect(half(1)).toBeLessThan(half(3))
    expect(half(3)).toBeLessThan(half(8))
  })

  test('zero lag is instant', () => {
    const s = new Shower({ delaySec: 0 })
    s.setKnob(s.knob + 10)
    s.step()
    expect(s.water).toBeCloseTo(START_TEMP + 10, 6)
  })

  test('a knob pulse shorter than the lag is blunted and arrives after it ended', () => {
    const s = new Shower({ delaySec: 3 })
    const base = s.knob
    const water: number[] = []
    for (let i = 0; i < 12 / s.stepSec; i++) {
      s.setKnob(i * s.stepSec < 0.5 ? base + 10 : base) // half-second pulse
      s.step()
      water.push(s.water)
    }
    const peak = Math.max(...water)
    expect(peak - START_TEMP).toBeLessThan(2) // under a fifth of the pulse's height (analytically ~1.35)
    expect(water.indexOf(peak) * s.stepSec).toBeGreaterThan(0.5) // peaks after the pulse ended
    expect(water.at(-1)! - START_TEMP).toBeLessThan(0.2) // and fades away
  })

  test('re-adjusting does not reset earlier moves: they still arrive', () => {
    const s = new Shower({ delaySec: 3 })
    const base = s.knob
    s.setKnob(base + 10)
    for (let i = 0; i < 20; i++) s.step() // 1s in, then keep jiggling
    for (let i = 0; i < 200; i++) {
      s.setKnob(base + 10 + (i % 2 ? 0.1 : -0.1))
      s.step()
    }
    expect(s.water).toBeGreaterThan(base + 8) // jiggling did not stall the response
  })

  test('hidden offset shifts the steady-state water relative to the knob', () => {
    const { water } = stepResponse(0, 0, 1, 4)
    expect(water.at(-1)).toBeCloseTo(START_TEMP, 3) // equilibrium start, no movement
    const s = new Shower({ delaySec: 0, offset: 4 })
    s.setKnob(30)
    s.step()
    expect(s.water).toBeCloseTo(34, 3)
  })

  test('starts in equilibrium: knob is placed so the water equals the start temperature', () => {
    for (const off of [-6, -2.5, 0, 3, 6]) {
      const s = new Shower({ delaySec: 2, offset: off })
      expect(s.water).toBe(START_TEMP)
      for (let i = 0; i < 100; i++) s.step() // knob untouched
      expect(s.water).toBeCloseTo(START_TEMP, 3)
    }
  })

  test('knob is clamped to the temperature range', () => {
    const s = new Shower({ delaySec: 0 })
    s.setKnob(999)
    expect(s.knob).toBe(T_MAX)
    s.setKnob(-5)
    expect(s.knob).toBe(T_MIN)
  })
})

describe('randomOffset', () => {
  test('stays within ±MAX_OFFSET on half-degree steps', () => {
    for (let i = 0; i < 200; i++) {
      const o = randomOffset()
      expect(Math.abs(o)).toBeLessThanOrEqual(MAX_OFFSET)
      expect(o * 2).toBe(Math.round(o * 2))
    }
  })

  test('every target stays reachable at the extreme offsets', () => {
    for (const off of [-MAX_OFFSET, MAX_OFFSET]) {
      for (const target of [randomTarget(() => 0), randomTarget(() => 1)]) {
        const needed = target - off
        expect(needed).toBeGreaterThanOrEqual(T_MIN)
        expect(needed).toBeLessThanOrEqual(T_MAX)
      }
    }
  })
})

describe('randomTarget', () => {
  test('stays in range and on half-degree steps', () => {
    for (let i = 0; i < 200; i++) {
      const t = randomTarget()
      expect(t).toBeGreaterThanOrEqual(24)
      expect(t).toBeLessThanOrEqual(42)
      expect(t * 2).toBe(Math.round(t * 2))
    }
  })

  test('is far enough from the start temperature that the player has to move', () => {
    expect(randomTarget(() => 0) - START_TEMP).toBeGreaterThanOrEqual(5)
  })
})

describe('nextTarget', () => {
  test('is always in range and at least MIN_JUMP from the previous target', () => {
    for (const prev of [24, 30, 33, 42]) {
      for (let i = 0; i < 100; i++) {
        const n = nextTarget(prev)
        expect(n).toBeGreaterThanOrEqual(24)
        expect(n).toBeLessThanOrEqual(42)
        expect(Math.abs(n - prev)).toBeGreaterThanOrEqual(MIN_JUMP)
      }
    }
  })

  test('falls back deterministically with a degenerate rng', () => {
    expect(Math.abs(nextTarget(30, () => 0.5) - 30)).toBeGreaterThanOrEqual(MIN_JUMP) // 33 is too close
    expect(nextTarget(30, () => 0.5)).toBeDefined()
  })
})

describe('Round', () => {
  const dt = 0.5
  const run = (r: Round, water: number, sec: number): boolean[] => {
    const moved: boolean[] = []
    for (let i = 0; i < sec / dt; i++) moved.push(r.update(water, dt))
    return moved
  }

  test('target moves only after the water has been in the band STABLE_SEC straight', () => {
    const r = new Round(30, BAND, 60, () => 40)
    const moved = run(r, 30, STABLE_SEC)
    expect(moved.slice(0, -1).every((m) => !m)).toBe(true)
    expect(moved.at(-1)).toBe(true)
    expect(r.target).toBe(40)
    expect(r.hits).toBe(1)
  })

  test('leaving the band resets the stability timer', () => {
    const r = new Round(30, BAND, 60, () => 40)
    run(r, 30, STABLE_SEC - dt) // almost there
    run(r, 20, dt) // slips out
    expect(r.stableSec).toBe(0)
    const moved = run(r, 30, STABLE_SEC - dt)
    expect(moved.some((m) => m)).toBe(false) // had to start over
    expect(r.hits).toBe(0)
  })

  test('holdFraction tracks progress towards stable', () => {
    const r = new Round(30, BAND, 60)
    run(r, 30, STABLE_SEC / 2)
    expect(r.holdFraction).toBeCloseTo(0.5, 5)
  })

  test('counts hits across several targets', () => {
    const targets = [40, 28, 36]
    const r = new Round(30, BAND, 60, () => targets.shift() ?? 30)
    run(r, 30, STABLE_SEC)
    run(r, 40, STABLE_SEC)
    run(r, 28, STABLE_SEC)
    expect(r.hits).toBe(3)
    expect(r.target).toBe(36)
  })

  test('scores overshoot and lost-band events per target', () => {
    const r = new Round(30, BAND, 60, () => 40)
    run(r, 20, 1) // cold, never reached: not a lost band
    run(r, 30, 1) // reaches the band
    run(r, 35, 1) // overshoots, loses the band
    expect(r.result().lostBand).toBe(1)
    expect(r.result().overshoot).toBe(5)
    run(r, 30, STABLE_SEC) // settles -> hit
    expect(r.result()).toMatchObject({ hits: 1, lostBand: 1, overshoot: 5 })
  })

  test('a target that moves away from the water is not counted as overshoot', () => {
    const targets = [25]
    const r = new Round(42, BAND, 60, () => targets.shift() ?? 25)
    run(r, 42, STABLE_SEC) // hit; target drops to 25 while the water sits at 42
    run(r, 42, 2) // still far above the new target, never in its band
    expect(r.result().overshoot).toBe(0)
    expect(r.result().lostBand).toBe(0)
  })

  test('undershoot after reaching the band counts too', () => {
    const r = new Round(30, BAND, 60, () => 40)
    run(r, 30, 1)
    run(r, 24, 1) // dropped 6 below
    expect(r.result().overshoot).toBe(6)
  })

  test('stops scoring once the round is over', () => {
    const r = new Round(30, BAND, 1)
    r.update(30, 1)
    expect(r.update(99, 1)).toBe(false)
    expect(r.result().overshoot).toBe(0)
  })
})
