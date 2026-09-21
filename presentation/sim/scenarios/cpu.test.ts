import { describe, expect, test } from 'vitest'
import { cpuScenario } from './cpu'
import { defaults, type Params } from './types'

const base = defaults(cpuScenario.params)
const run = (over: Params = {}) => cpuScenario.run({ ...base, ...over })
const sum = (xs: number[]) => xs.reduce((a, b) => a + b, 0)

describe('cpu scenario', () => {
  test('returns aligned series for every charted key', () => {
    const r = run({ horizonSec: 600, sampleSec: 10 })
    expect(r.t.length).toBe(61)
    for (const c of cpuScenario.charts) for (const s of c.series) expect(r.series[s.key]?.length).toBe(61)
  })

  test('is deterministic', () => {
    expect(run()).toEqual(run())
  })

  test('marker at load start', () => {
    const r = run({ quietSec: 300 })
    expect(r.markers).toEqual([{ t: 300, label: 'load starts →' }])
  })

  test('stable base load: cluster pre-sized, ~no errors before the ramp', () => {
    // 400 rps × 0.1 s = 40 slots; 16 per instance at 50% → 5
    const r = run({ rps: 800, baseRps: 400, quietSec: 300, horizonSec: 300, sampleSec: 10 })
    expect(r.series.instances[0]).toBe(5)
    const failed = sum(r.series.failedRps), ok = sum(r.series.okRps)
    expect(failed / (ok + failed)).toBeLessThan(0.01)
  })

  test('step ramp: offered goes base → rps at quietSec', () => {
    const r = run({ rps: 100, baseRps: 20, ramp: 'step', quietSec: 300, horizonSec: 400, sampleSec: 10 })
    expect(r.series.offeredRps[29]).toBe(20)
    expect(r.series.offeredRps[30]).toBe(100)
  })

  test('linear ramp interpolates from base', () => {
    const r = run({ rps: 100, baseRps: 50, ramp: 'linear', rampSec: 200, quietSec: 0, horizonSec: 400, sampleSec: 10 })
    expect(r.series.offeredRps[0]).toBe(50)
    expect(r.series.offeredRps[10]).toBeCloseTo(75)
    expect(r.series.offeredRps[20]).toBeCloseTo(100)
  })

  test('default HPA settings overshoot; countInFlight removes the overshoot', () => {
    const naive = run({ horizonSec: 1500 })
    const smart = run({ horizonSec: 1500, countInFlight: true })
    const peakNaive = Math.max(...naive.series.instances)
    const peakSmart = Math.max(...smart.series.instances)
    expect(peakNaive).toBeGreaterThan(20)
    expect(peakSmart).toBeLessThanOrEqual(8)
    expect(smart.series.instances.at(-1)).toBe(5)
  })

  test('threshold algorithm is selectable', () => {
    const r = run({ algo: 'threshold', upAt: 0.7, downAt: 0.3, stepSize: 1, horizonSec: 900 })
    expect(Math.max(...r.series.instances)).toBeGreaterThan(2)
  })

  test('summary reports needed / peak / final / error %', () => {
    const r = run()
    expect(Object.keys(r.summary)).toEqual(['needed', 'peak', 'final', 'errors %'])
  })
})
