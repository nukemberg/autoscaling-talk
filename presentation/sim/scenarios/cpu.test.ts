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
    const r = runCpuScenario({ rps: 100, latencyMs: 50, horizon: 300, sample: 10, quietSec: 0 })
    expect(r.offeredRps.length).toBe(31)
    expect(r.okRps.length).toBe(31)
    expect(r.failedRps.length).toBe(31)
    expect(Math.max(...r.okRps)).toBeGreaterThan(50)
  })

  test('quiet period: baseRps before quietSec (default 300), step ramp goes to rps at quietSec', () => {
    const r = runCpuScenario({ rps: 100, baseRps: 20, latencyMs: 50, horizon: 400, sample: 10, ramp: 'step' })
    expect(r.offeredRps[0]).toBe(20)
    expect(r.offeredRps[29]).toBe(20)
    expect(r.offeredRps[30]).toBe(100)
  })

  test('cluster starts sized for baseRps and serves it without failures', () => {
    // 400 rps * 0.1 s = 40 slots; 16 per instance at 50% → 5 instances
    const r = runCpuScenario({ rps: 800, baseRps: 400, latencyMs: 100, horizon: 300, sample: 10 })
    expect(r.instances[0]).toBe(5)
    const failed = r.failedRps.slice(0, 30).reduce((a, b) => a + b, 0)
    const ok = r.okRps.slice(0, 30).reduce((a, b) => a + b, 0)
    expect(failed / (ok + failed)).toBeLessThan(0.01)
  })

  test('linear ramp interpolates from baseRps', () => {
    const r = runCpuScenario({ rps: 100, baseRps: 50, latencyMs: 50, horizon: 400, sample: 10, ramp: 'linear', rampSec: 200, quietSec: 0 })
    expect(r.offeredRps[0]).toBe(50)
    expect(r.offeredRps[10]).toBeCloseTo(75)
  })

  test('quietSec is configurable', () => {
    const r = runCpuScenario({ rps: 100, baseRps: 0, latencyMs: 50, horizon: 100, sample: 10, ramp: 'step', quietSec: 0 })
    expect(r.offeredRps[0]).toBe(100)
  })

  test('linear ramp reaches full rate at rampSec', () => {
    const r = runCpuScenario({ rps: 100, latencyMs: 50, horizon: 400, sample: 10, ramp: 'linear', rampSec: 200, quietSec: 0 })
    expect(r.offeredRps[0]).toBe(0)
    expect(r.offeredRps[10]).toBeCloseTo(50)
    expect(r.offeredRps[20]).toBeCloseTo(100)
  })

  test('logistic ramp is ~half at rampSec/2', () => {
    const r = runCpuScenario({ rps: 100, latencyMs: 50, horizon: 400, sample: 10, ramp: 'logistic', rampSec: 200, quietSec: 0 })
    expect(r.offeredRps[10]).toBeCloseTo(50, 3)
    expect(r.offeredRps[30]).toBeCloseTo(100, 0)
  })
})
