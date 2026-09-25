import { describe, expect, test } from 'vitest'
import cpuOscillation from '../../presets/cpu-oscillation.json'
import cpuStep from '../../presets/cpu-step.json'
import { cpuScenario } from './cpu'
import { resolvePreset, type Preset } from './preset'
import { defaults, type Params } from './types'

const base = defaults(cpuScenario.params)
const run = (over: Params = {}) => cpuScenario.run({ ...base, ...over })
/** Runs the preset JSON the slides actually load, so these tests track what's on stage. */
const presets: Record<string, Preset> = { 'cpu-oscillation': cpuOscillation, 'cpu-step': cpuStep }
const runPreset = (name: string) => cpuScenario.run(resolvePreset(presets[name]).params)
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

  test('scaling metric series lands on the [0,100] pct axis for the default (cpu, utilization) case', () => {
    // Regression for the bug where controller.metric (a 0..1 fraction for utilization metrics)
    // was plotted unconverted onto a hardcoded [0,100] axis, so the line sat flat near 0-1.
    const r = run({ horizonSec: 1200, sampleSec: 10 })
    const metric = r.series.metric.slice(5) // skip the first couple samples before the controller has data
    expect(metric.length).toBeGreaterThan(0)
    for (const v of metric) {
      expect(v).toBeGreaterThanOrEqual(0)
      expect(v).toBeLessThanOrEqual(100)
    }
    expect(Math.max(...metric)).toBeGreaterThan(1) // would fail at ~0.5-0.9 pre-fix
  })

  test('markers at load start and fault', () => {
    expect(run({ quietSec: 300 }).markers).toEqual([{ t: 300, label: 'load starts →' }])
    expect(run({ quietSec: 300, faultKind: 'kill', faultAtSec: 900 }).markers).toEqual([
      { t: 300, label: 'load starts →' }, { t: 900, label: 'kill →' },
    ])
  })

  test('kill fault: instances drop, only 1 of 2 gets replaced — because only 1 was actually needed', () => {
    // faultAtSec avoids being a multiple of the default hpaSyncSec (15): warmupEnd (t0) is a fixed
    // 150s from bootSec/healthCheckSec, so t0 + faultAtSec landing on an HPA sync tick would let a
    // same-instant scale-up recommendation fire (in scheduling order) before the very next sample,
    // masking the crash. Traced via instrumented run: with faultAtSec: 1200 (a multiple of 15), the
    // recorded "instances" sample at the fault's own tick showed no drop at all, even though
    // Cluster.crash() had already reduced cluster.size moments earlier in the same event batch.
    //
    // Investigated as autoscaling-talk-bmj ("only 1 of 2 crashes gets replaced") and closed as not
    // a bug: traced the HPA math at the next sync and it's textbook-correct. 6 instances pre-crash
    // was over-provisioned; the 4 survivors average 62.5% CPU against a 50% target, so
    // ceil(4 * 1.25) = 5 is the genuinely correct target, not 6. The next sync correctly sets aside
    // the booting 5th pod (real k8s's missing-pod dampening, already implemented in hpa.ts) and
    // settles within tolerance at 5. A separate probe (two simultaneous crashes with no HPA
    // involved) confirmed Cluster.crash()'s replace-timers do both fire when replacements are
    // actually needed — there's no race between them.
    const r = run({ faultKind: 'kill', faultAtSec: 1210, faultCount: 2, replaceDeadSec: 60, sampleSec: 10, cores: 16, cpuTimeMs: 100 })
    const i = (t: number) => r.series.instances[t / 10]
    const before = i(1200)
    expect(i(1210)).toBe(before - 2)
    expect(i(1280)).toBe(before - 1)
  })

  test('hang fault with spinning CPU: scaler sees 100% and adds instances it does not need', () => {
    const r = run({ faultKind: 'hang', faultAtSec: 1200, faultCount: 2, faultDurationSec: 300, hungCpu: 'spinning', sampleSec: 10 })
    const before = r.series.instances[119]
    const during = Math.max(...r.series.instances.slice(120, 150))
    expect(during).toBeGreaterThan(before)
    // LB drops the hung ones after 3 failed checks
    expect(Math.min(...r.series.inRotation.slice(124, 150))).toBe(before - 2)
  })

  test('metricLatency:true end-to-end: controller scales up on rising latency, chart shows raw ms not ×100 (2ae)', () => {
    // Regression for Task 7's bug: cpu.ts hardcoded Stats({track: false}), so latencyMetric's
    // windowed query silently always read 0 for every preset. Exercises the real scenario wiring
    // (not a hand-built Stats like metricRegistry.test.ts) so a future regression in that wiring
    // shows up here. A shared, fixed-size DB pool (not per-instance queueing) is the bottleneck —
    // same mechanism as the shipped latency-runaway preset — so latency genuinely runs away
    // instead of plateauing at whatever a per-instance queue can absorb.
    const r = run({
      metricCpu: false, metricLatency: true, maxInstances: 20,
      baseRps: 50, rps: 100, quietSec: 60, rampSec: 10, horizonSec: 300, sampleSec: 10,
      workers: 200, queueSlots: 400, dbPoolSlots: 2, dbQueryMs: 30,
    })
    expect(r.series.instances[r.series.instances.length - 1]).toBeGreaterThan(r.series.instances[0])
    const latterHalf = r.series.metric.slice(Math.floor(r.series.metric.length / 2))
    // latency is an 'absolute' metric — the chart plots raw ms, not the ×100 utilization scaling.
    // Under this runaway, ms values run into the thousands, far past a 0-100 axis — if the
    // wiring silently dropped back to a 0-ish value, this is what would catch it.
    expect(Math.min(...latterHalf)).toBeGreaterThan(1000)
  })

  test('stable base load: cluster pre-sized, ~no errors before the ramp', () => {
    // capacity = cores * 1000 / cpuTimeMs = 16 * 1000 / 100 = 160 rps/instance; 400 rps at 50% → 5
    const r = run({ rps: 800, baseRps: 400, quietSec: 300, horizonSec: 300, sampleSec: 10, cores: 16, cpuTimeMs: 100 })
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

  test('every algorithm converges near the needed size for a step', () => {
    for (const algo of ['hpa', 'aws-target', 'aws-step', 'aws-simple']) {
      const r = run({ algo, horizonSec: 3000, cores: 16, cpuTimeMs: 100 })
      const end = r.series.instances.slice(-20)
      expect(Math.max(...r.series.instances), algo).toBeGreaterThan(2)
      expect(Math.min(...end), algo).toBeGreaterThanOrEqual(4)
      expect(Math.max(...end), algo).toBeLessThanOrEqual(12)
    }
  })

  test('cpu-oscillation preset (as shipped): overshoot, undershoot, then sustained flapping', () => {
    const r = runPreset('cpu-oscillation')
    const needed = Number(r.summary.needed)
    const peak = Math.max(...r.series.instances)
    const trough = Math.min(...r.series.instances.slice(90)) // after the first overshoot has formed
    expect(peak).toBeGreaterThan(needed * 2) // overshoot well past what the new load needs
    expect(trough).toBeLessThan(needed) // scale-in undershoots below it
    // keeps flapping in the second half instead of settling to one value
    const tail = r.series.instances.slice(150)
    expect(Math.max(...tail) - Math.min(...tail)).toBeGreaterThan(5)
  })

  test('cpu-step preset (as shipped): the well-behaved reference — scales 2 → 4 → 5-6, no overshoot', () => {
    const r = runPreset('cpu-step')
    expect(r.series.instances[0]).toBe(2)
    expect(Number(r.summary.needed)).toBe(5)
    expect(r.summary.peak).toBeLessThanOrEqual(6)
    expect(r.summary.final).toBeGreaterThanOrEqual(5)
    expect(r.summary.final).toBe(r.summary.peak) // never scales past where it ends up
  })

  test('summary reports needed / peak / final / error %', () => {
    const r = run()
    expect(Object.keys(r.summary)).toEqual(['needed', 'peak', 'final', 'errors %'])
  })
})
