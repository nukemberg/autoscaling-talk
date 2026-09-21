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
