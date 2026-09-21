import { describe, expect, test } from 'vitest'
import { Sim } from './engine'
import { Rng } from './rng'
import { Arrivals, constant, ramp, spike, step, sum } from './arrivals'
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
