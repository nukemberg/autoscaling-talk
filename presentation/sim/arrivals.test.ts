import { describe, expect, test } from 'vitest'
import { Sim } from './engine'
import { Rng } from './rng'
import {
  Arrivals, boxcar, constant, expGrowth, flashCrowd, gaussian, logistic, noisy, ramp, sawtooth, sine,
  spike, squareWave, step, sum, trapezoid,
} from './arrivals'
import type { Request } from './types'

function collect(sim: Sim) {
  const reqs: Request[] = []
  return { reqs, sink: (r: Request) => { reqs.push(r) } }
}

describe('rate profiles', () => {
  test('constant', () => {
    expect(constant(5)(0)).toBe(5)
    expect(constant(5)(100)).toBe(5)
  })
  test('step switches at t0', () => {
    const r = step(10, 2, 8)
    expect(r(9.9)).toBe(2)
    expect(r(10)).toBe(8)
  })
  test('ramp interpolates between t0 and t1', () => {
    const r = ramp(10, 20, 0, 100)
    expect(r(5)).toBe(0)
    expect(r(15)).toBe(50)
    expect(r(25)).toBe(100)
  })
  test('spike adds extra rate for a window', () => {
    const r = spike(10, 5, 100)
    expect(r(9)).toBe(0)
    expect(r(12)).toBe(100)
    expect(r(15)).toBe(0)
  })
  test('sum adds profiles', () => {
    const r = sum(constant(1), spike(10, 5, 9))
    expect(r(0)).toBe(1)
    expect(r(12)).toBe(10)
  })
  test('boxcar holds `to` inside the window, `from` outside', () => {
    const r = boxcar(10, 5, 2, 8)
    expect(r(9)).toBe(2)
    expect(r(12)).toBe(8)
    expect(r(15)).toBe(2)
    expect(r.max).toBe(8)
  })
  test('gaussian peaks at center, decays to ~from at the edges', () => {
    const r = gaussian(100, 20, 10, 110)
    expect(r(100)).toBeCloseTo(110, 5)
    expect(r(0)).toBeCloseTo(10, 0)
    expect(r(200)).toBeCloseTo(10, 0)
    expect(r(80)).toBeGreaterThan(10)
    expect(r(80)).toBeLessThan(110)
  })
  test('sine oscillates between from and to with the given period', () => {
    const r = sine(0, 100, 0, 100)
    expect(r(0)).toBeCloseTo(50, 5)
    expect(r(25)).toBeCloseTo(100, 5)
    expect(r(75)).toBeCloseTo(0, 5)
    expect(r.max).toBe(100)
  })
  test('sawtooth ramps then resets each period', () => {
    const r = sawtooth(0, 100, 0, 100)
    expect(r(0)).toBeCloseTo(0, 5)
    expect(r(50)).toBeCloseTo(50, 5)
    expect(r(99.999)).toBeCloseTo(100, 1)
    expect(r(100)).toBeCloseTo(0, 5)
  })
  test('squareWave holds `to` for the duty fraction, `from` otherwise', () => {
    const r = squareWave(0, 100, 0.3, 2, 8)
    expect(r(10)).toBe(8)
    expect(r(50)).toBe(2)
    expect(r(110)).toBe(8)
  })
  test('trapezoid rises, holds, and falls', () => {
    const r = trapezoid(0, 10, 20, 0, 100)
    expect(r(5)).toBeCloseTo(50, 5)
    expect(r(20)).toBeCloseTo(100, 5)
    expect(r(35)).toBeCloseTo(50, 5)
    expect(r(50)).toBeCloseTo(0, 5)
  })
  test('expGrowth grows from `from`, caps at `cap`', () => {
    const r = expGrowth(0, 50, 10, 1000)
    expect(r(0)).toBeCloseTo(10, 5)
    expect(r(50)).toBeCloseTo(10 * Math.E, 3)
    expect(r(1000)).toBe(1000)
    expect(r.max).toBe(1000)
  })
  test('flashCrowd spikes then decays exponentially back toward `from`', () => {
    const r = flashCrowd(0, 5, 30, 10, 500)
    expect(r(0)).toBeCloseTo(10, 5)
    expect(r(5)).toBeCloseTo(500, 5)
    expect(r(35)).toBeCloseTo(10 + 490 / Math.E, 1)
    expect(r(1000)).toBeCloseTo(10, 0)
  })
  test('noisy jitters a base profile within bounds, seeded reproducibly', () => {
    const r = noisy(constant(100), new Rng(1), 0.2)
    for (let t = 0; t < 50; t++) {
      const v = r(t)
      expect(v).toBeGreaterThanOrEqual(80)
      expect(v).toBeLessThanOrEqual(120)
    }
    expect(noisy(constant(100), new Rng(1), 0.2)(5)).toBe(noisy(constant(100), new Rng(1), 0.2)(5))
  })
})

describe('Arrivals', () => {
  test('emits requests with increasing ids and arrivedAt = now', () => {
    const sim = new Sim()
    const { reqs, sink } = collect(sim)
    new Arrivals(sim, new Rng(1), constant(10), sink).start()
    sim.run(5)
    expect(reqs.length).toBeGreaterThan(0)
    expect(reqs.map((r) => r.id)).toEqual(reqs.map((_, i) => i))
    for (let i = 1; i < reqs.length; i++) expect(reqs[i].arrivedAt).toBeGreaterThanOrEqual(reqs[i - 1].arrivedAt)
  })

  test('constant rate λ yields ≈ λ·T requests', () => {
    const sim = new Sim()
    const { reqs, sink } = collect(sim)
    new Arrivals(sim, new Rng(2), constant(100), sink).start()
    sim.run(100)
    expect(reqs.length).toBeGreaterThan(9500)
    expect(reqs.length).toBeLessThan(10500)
  })

  test('time-varying rate follows the profile (thinning)', () => {
    const sim = new Sim()
    const { reqs, sink } = collect(sim)
    new Arrivals(sim, new Rng(3), step(50, 10, 100), sink).start()
    sim.run(100)
    const before = reqs.filter((r) => r.arrivedAt < 50).length
    const after = reqs.length - before
    expect(before).toBeGreaterThan(350)
    expect(before).toBeLessThan(650)
    expect(after).toBeGreaterThan(4500)
    expect(after).toBeLessThan(5500)
  })

  test('zero rate emits nothing', () => {
    const sim = new Sim()
    const { reqs, sink } = collect(sim)
    new Arrivals(sim, new Rng(4), constant(0), sink).start()
    sim.run(10)
    expect(reqs).toEqual([])
  })

  test('stop halts arrivals', () => {
    const sim = new Sim()
    const { reqs, sink } = collect(sim)
    const a = new Arrivals(sim, new Rng(5), constant(10), sink)
    a.start()
    sim.schedule(5, () => a.stop())
    sim.run(20)
    expect(reqs.every((r) => r.arrivedAt <= 5)).toBe(true)
  })
})

describe('logistic', () => {
  test('S-curve from `from` to `to`, centred on t0 + duration/2', () => {
    const r = logistic(100, 200, 0, 1000)
    expect(r(0)).toBeCloseTo(0, 0)
    expect(r(200)).toBeCloseTo(500, 5)
    expect(r(400)).toBeCloseTo(1000, 0)
    expect(r(150)).toBeGreaterThan(50)
    expect(r(150)).toBeLessThan(500)
    expect(r.max).toBe(1000)
  })
})
