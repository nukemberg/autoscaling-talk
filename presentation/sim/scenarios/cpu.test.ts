import { describe, expect, test } from 'vitest'
import { runCpuScenario } from './cpu'

describe('runCpuScenario', () => {
  test('returns aligned series over the horizon', () => {
    const r = runCpuScenario({ rps: 100, latencyMs: 50, horizon: 600, sample: 10 })
    expect(r.t.length).toBe(61)
    expect(r.instances.length).toBe(61)
    expect(r.cpu.length).toBe(61)
    expect(r.p99Ms.length).toBe(61)
    expect(r.rejected.length).toBe(61)
  })

  test('is deterministic', () => {
    const a = runCpuScenario({ rps: 100, latencyMs: 50 })
    const b = runCpuScenario({ rps: 100, latencyMs: 50 })
    expect(a).toEqual(b)
  })

  test('scales up under load and ends near the capacity the load needs', () => {
    // 200 rps * 0.1s = 20 busy slots; 16 per instance at 50% target → ~2.5 instances
    const r = runCpuScenario({ rps: 200, latencyMs: 100, horizon: 3000 })
    const end = r.instances.slice(-10)
    expect(Math.max(...r.instances)).toBeGreaterThan(1)
    expect(Math.min(...end)).toBeGreaterThanOrEqual(2)
    expect(Math.max(...end)).toBeLessThanOrEqual(6)
  })

  test('tiny load stays at min', () => {
    const r = runCpuScenario({ rps: 1, latencyMs: 10, horizon: 1000 })
    expect(Math.max(...r.instances)).toBe(1)
  })
})

describe('ramp + throughput series', () => {
  test('exposes offered, ok and failed rps series', () => {
    const r = runCpuScenario({ rps: 100, latencyMs: 50, horizon: 300, sample: 10 })
    expect(r.offeredRps.length).toBe(31)
    expect(r.okRps.length).toBe(31)
    expect(r.failedRps.length).toBe(31)
    expect(Math.max(...r.okRps)).toBeGreaterThan(50)
  })

  test('step ramp: offered rate is full from t=0', () => {
    const r = runCpuScenario({ rps: 100, latencyMs: 50, horizon: 100, ramp: 'step', rampSec: 300 })
    expect(r.offeredRps[0]).toBe(100)
  })

  test('linear ramp reaches full rate at rampSec', () => {
    const r = runCpuScenario({ rps: 100, latencyMs: 50, horizon: 400, sample: 10, ramp: 'linear', rampSec: 200 })
    expect(r.offeredRps[0]).toBe(0)
    expect(r.offeredRps[10]).toBeCloseTo(50)
    expect(r.offeredRps[20]).toBeCloseTo(100)
  })

  test('logistic ramp is ~half at rampSec/2', () => {
    const r = runCpuScenario({ rps: 100, latencyMs: 50, horizon: 400, sample: 10, ramp: 'logistic', rampSec: 200 })
    expect(r.offeredRps[10]).toBeCloseTo(50, 3)
    expect(r.offeredRps[30]).toBeCloseTo(100, 0)
  })
})
