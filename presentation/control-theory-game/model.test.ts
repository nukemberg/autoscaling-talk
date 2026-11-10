import { describe, expect, test } from 'vitest'
import { BAND, MAX_OFFSET, MIN_JUMP, nextTarget, randomOffset, randomTarget, Round, Shower, START_TEMP, STABLE_SEC, T_MAX, T_MIN } from './model'

// Tiny smoothing so the water tracks the (delayed) knob almost exactly.
const sharp = (delaySec: number, offset = 0) => new Shower({ delaySec, smoothSec: 1e-6, offset })

describe('Shower', () => {
  test('water does not move until the pipe delay has elapsed', () => {
    const s = sharp(2) // 40 steps at 0.05s
    s.setKnob(40)
    for (let i = 0; i < 39; i++) s.step()
    expect(s.water).toBeCloseTo(START_TEMP, 3)
    s.step()
    s.step()
    expect(s.water).toBeCloseTo(40, 3)
  })

  test('zero delay responds on the very next tick', () => {
    const s = sharp(0)
    s.setKnob(30)
    s.step()
    expect(s.water).toBeCloseTo(30, 3)
  })

  test('a short knob pulse reaches the water exactly one delay later, unchanged', () => {
    const s = sharp(2) // 40 steps
    const water: number[] = []
    for (let i = 0; i < 80; i++) {
      s.setKnob(i >= 5 && i < 15 ? 45 : START_TEMP) // 10-step pulse starting at step 5
      s.step()
      water.push(s.water)
    }
    // Pulse enters the pipe at steps 5..14 and exits exactly delaySteps (40) ticks later: 45..54.
    const hot = water.map((w, i) => (w > 30 ? i : -1)).filter((i) => i >= 0)
    expect(hot.length).toBe(10)
    expect(hot[0]).toBe(5 + 40)
    expect(Math.max(...water.slice(0, hot[0]))).toBeCloseTo(START_TEMP, 3)
  })

  test('smoothing makes the water approach the setting without overshooting it', () => {
    const s = new Shower({ delaySec: 0, smoothSec: 0.5 })
    s.setKnob(30)
    let prev = s.water
    for (let i = 0; i < 200; i++) {
      s.step()
      expect(s.water).toBeGreaterThanOrEqual(prev)
      expect(s.water).toBeLessThanOrEqual(30)
      prev = s.water
    }
    expect(s.water).toBeCloseTo(30, 1)
  })

  test('hidden offset shifts the steady-state water relative to the knob', () => {
    const s = sharp(0, 4)
    s.setKnob(30)
    s.step()
    expect(s.water).toBeCloseTo(34, 3)
  })

  test('starts in equilibrium: knob is placed so the water equals the start temperature', () => {
    for (const off of [-6, -2.5, 0, 3, 6]) {
      const s = sharp(2, off)
      expect(s.water).toBe(START_TEMP)
      for (let i = 0; i < 100; i++) s.step() // knob untouched
      expect(s.water).toBeCloseTo(START_TEMP, 3)
    }
  })

  test('knob is clamped to the temperature range', () => {
    const s = sharp(0)
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
