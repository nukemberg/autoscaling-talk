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

  test('markers at load start and fault', () => {
    expect(run({ quietSec: 300 }).markers).toEqual([{ t: 300, label: 'load starts →' }])
    expect(run({ quietSec: 300, faultKind: 'kill', faultAtSec: 900 }).markers).toEqual([
      { t: 300, label: 'load starts →' }, { t: 900, label: 'kill →' },
    ])
  })

  test('kill fault: instances drop, then are replaced', () => {
    const r = run({ countInFlight: true, faultKind: 'kill', faultAtSec: 1200, faultCount: 2, replaceDeadSec: 60, sampleSec: 10 })
    const i = (t: number) => r.series.instances[t / 10]
    expect(i(1190)).toBe(5)
    expect(i(1200)).toBe(3)
    expect(i(1270)).toBe(5)
  })

  test('hang fault with spinning CPU: scaler sees 100% and adds instances it does not need', () => {
    const r = run({ countInFlight: true, faultKind: 'hang', faultAtSec: 1200, faultCount: 2, faultDurationSec: 300, hungCpu: 'spinning', sampleSec: 10 })
    const before = r.series.instances[119]
    const during = Math.max(...r.series.instances.slice(120, 150))
    expect(during).toBeGreaterThan(before)
    // LB drops the hung ones after 3 failed checks
    expect(Math.min(...r.series.inRotation.slice(124, 150))).toBe(before - 2)
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

  test('cpu-oscillation preset: overshoot, undershoot, then sustained chatter', () => {
    const r = run({
      baseRps: 300, rps: 1360, algo: 'threshold', upAt: 0.55, downAt: 0.45,
      periodSec: 15, windowSec: 15, bootSec: 240, maxInstances: 50, horizonSec: 3000, sampleSec: 10,
    })
    const settled = 4 // cluster pre-sized for baseRps
    const peak = Math.max(...r.series.instances)
    const trough = Math.min(...r.series.instances.slice(30)) // after the ramp starts
    expect(peak).toBeGreaterThan(settled * 2) // overshoot well past what the new load needs
    expect(trough).toBeLessThan(peak - 5) // scale-in undershoots below the eventual band
    // keeps flapping in the second half instead of settling to one value
    const tail = r.series.instances.slice(150)
    expect(new Set(tail).size).toBeGreaterThan(1)
  })

  test('summary reports needed / peak / final / error %', () => {
    const r = run()
    expect(Object.keys(r.summary)).toEqual(['needed', 'peak', 'final', 'errors %'])
  })
})
