import { describe, expect, test } from 'vitest'
import { Sim } from './engine'
import { Stats } from './stats'
import type { Outcome } from './types'

function done(sim: Sim, latency: number, outcome: Outcome = 'ok') {
  return { id: 0, arrivedAt: sim.now - latency, doneAt: sim.now, outcome }
}

describe('Stats', () => {
  test('throughput(window) = ok completions per time unit in the window', () => {
    const sim = new Sim()
    const s = new Stats(sim)
    for (let t = 1; t <= 10; t++) sim.schedule(t, () => { s.record(done(sim, 0.1)); s.record(done(sim, 0.1, 'error')) })
    sim.run(10)
    expect(s.throughput(5)).toBeCloseTo(1)   // t=5..10 → 5 ok / 5
    expect(s.errorRate(5)).toBeCloseTo(0.5)
  })

  test('latency(window) percentile over ok requests in window', () => {
    const sim = new Sim()
    const s = new Stats(sim)
    sim.schedule(1, () => s.record(done(sim, 100)))
    sim.schedule(8, () => s.record(done(sim, 1)))
    sim.schedule(9, () => s.record(done(sim, 2)))
    sim.run(10)
    expect(s.latency(5).percentile(0.5)).toBe(1)
    expect(s.latency(5).max).toBe(2)
    expect(s.latency(10).max).toBe(100)
  })

  test('totals accumulate by outcome', () => {
    const sim = new Sim()
    const s = new Stats(sim)
    s.record(done(sim, 1)); s.record(done(sim, 1, 'rejected')); s.record(done(sim, 1, 'rejected'))
    expect(s.totals).toEqual({ ok: 1, rejected: 2, timeout: 0, error: 0 })
  })

  test('empty window → throughput 0, errorRate 0, empty tally', () => {
    const s = new Stats(new Sim())
    expect(s.throughput(5)).toBe(0)
    expect(s.errorRate(5)).toBe(0)
    expect(s.latency(5).count).toBe(0)
  })
})
