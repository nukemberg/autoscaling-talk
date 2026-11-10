import { describe, expect, test } from 'vitest'
import { BAND, randomTarget, Round, Shower, START_TEMP, T_MAX, T_MIN } from './model'

// Tiny smoothing so the water tracks the (delayed) knob almost exactly.
const sharp = (delaySec: number) => new Shower({ delaySec, smoothSec: 1e-6 })

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

  test('knob is clamped to the temperature range', () => {
    const s = sharp(0)
    s.setKnob(999)
    expect(s.knob).toBe(T_MAX)
    s.setKnob(-5)
    expect(s.knob).toBe(T_MIN)
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

describe('Round', () => {
  test('scores time in band, overshoot and lost-band events', () => {
    const r = new Round(30, BAND, 10)
    const dt = 0.5
    // 2s cold, 3s in band, 1s hot (overshoot + lost band), 2s in band, 2s cold (lost band again)
    const seq = [...Array(4).fill(20), ...Array(6).fill(30), ...Array(2).fill(35), ...Array(4).fill(30), ...Array(4).fill(20)]
    for (const w of seq) r.update(w, dt)
    expect(r.done).toBe(true)
    const res = r.result()
    expect(res.inBandPct).toBe(Math.round((100 * 10 * dt) / 10)) // 10 in-band updates of 20
    expect(res.overshoot).toBe(5)
    expect(res.lostBand).toBe(2)
  })

  test('leaving the band before ever reaching it is not a "lost band"', () => {
    const r = new Round(30, BAND, 10)
    for (let i = 0; i < 10; i++) r.update(i < 5 ? 15 : 20, 0.5)
    expect(r.result().lostBand).toBe(0)
    expect(r.result().overshoot).toBe(0)
  })

  test('stops scoring once the round is over', () => {
    const r = new Round(30, BAND, 1)
    r.update(30, 1)
    r.update(99, 1)
    expect(r.result().overshoot).toBe(0)
  })
})
