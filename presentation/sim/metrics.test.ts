import { describe, expect, test } from 'vitest'
import { Sim } from './engine'
import { Recorder, Tally, TimeWeighted } from './metrics'

describe('Tally', () => {
  test('empty tally has count 0 and NaN stats', () => {
    const t = new Tally()
    expect(t.count).toBe(0)
    expect(t.mean).toBeNaN()
    expect(t.percentile(0.5)).toBeNaN()
  })

  test('count, mean, min, max over added values', () => {
    const t = new Tally()
    for (const v of [4, 1, 3, 2]) t.add(v)
    expect(t.count).toBe(4)
    expect(t.mean).toBe(2.5)
    expect(t.min).toBe(1)
    expect(t.max).toBe(4)
  })

  test('percentile uses nearest-rank on sorted values', () => {
    const t = new Tally()
    for (let v = 1; v <= 100; v++) t.add(v)
    expect(t.percentile(0.5)).toBe(50)
    expect(t.percentile(0.99)).toBe(99)
    expect(t.percentile(1)).toBe(100)
    expect(t.percentile(0)).toBe(1)
  })

  test('reset clears values', () => {
    const t = new Tally()
    t.add(1)
    t.reset()
    expect(t.count).toBe(0)
  })
})

describe('TimeWeighted', () => {
  test('mean weights each level by how long it was held', () => {
    const sim = new Sim()
    const tw = new TimeWeighted(sim, 0)
    sim.schedule(2, () => tw.set(10))   // 0 for 2 units
    sim.schedule(4, () => tw.set(4))    // 10 for 2 units
    sim.run(8)                          // 4 for 4 units
    // (0*2 + 10*2 + 4*4) / 8 = 36/8
    expect(tw.mean).toBeCloseTo(4.5)
    expect(tw.value).toBe(4)
  })

  test('mean before any time passes is the initial value', () => {
    const sim = new Sim()
    const tw = new TimeWeighted(sim, 3)
    expect(tw.mean).toBe(3)
  })

  test('mean is over time since construction, not since t = 0', () => {
    const sim = new Sim()
    sim.run(10)
    const tw = new TimeWeighted(sim, 2)   // created at t=10
    sim.schedule(5, () => tw.set(4))      // 2 for 5 units
    sim.run(20)                           // 4 for 5 units
    expect(tw.mean).toBeCloseTo(3)        // (2*5 + 4*5) / 10, not / 20
  })

  test('integral accumulates value × time, including the in-progress segment', () => {
    const sim = new Sim()
    const tw = new TimeWeighted(sim, 0.5)
    sim.schedule(2, () => tw.set(1))      // 0.5 for 2 units → 1
    sim.run(3)                            // 1 for 1 unit (not yet closed by a set) → 1
    expect(tw.integral).toBeCloseTo(2)
    sim.run(5)
    expect(tw.integral).toBeCloseTo(4)    // keeps growing with no further set()
  })
})

describe('Recorder', () => {
  test('samples probes every period and exposes aligned arrays', () => {
    const sim = new Sim()
    let n = 0
    sim.schedule(2.5, () => { n = 5 })
    const rec = new Recorder(sim, 1, { n: () => n, twice: () => 2 * n })
    rec.start()
    sim.run(4)
    expect(rec.t).toEqual([0, 1, 2, 3, 4])
    expect(rec.series.n).toEqual([0, 0, 0, 5, 5])
    expect(rec.series.twice).toEqual([0, 0, 0, 10, 10])
  })

  test('toUPlot returns [t, ...series in probe order]', () => {
    const sim = new Sim()
    const rec = new Recorder(sim, 1, { a: () => 1, b: () => 2 })
    rec.start()
    sim.run(1)
    expect(rec.toUPlot()).toEqual([[0, 1], [1, 1], [2, 2]])
    expect(rec.names).toEqual(['a', 'b'])
  })

  test('stop halts sampling', () => {
    const sim = new Sim()
    const rec = new Recorder(sim, 1, { a: () => 1 })
    rec.start()
    sim.schedule(2.5, () => rec.stop())
    sim.run(10)
    expect(rec.t).toEqual([0, 1, 2])
  })
})
