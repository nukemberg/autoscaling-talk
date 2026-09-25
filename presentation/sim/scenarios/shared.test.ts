// presentation/sim/scenarios/shared.test.ts
import { describe, expect, test } from 'vitest'
import { Arrivals, constant } from '../arrivals'
import { Cluster } from '../cluster'
import { Sim } from '../engine'
import { LoadBalancer } from '../lb'
import { Rng } from '../rng'
import { Stats } from '../stats'
import {
  attachController, clusterOpts, instanceOpts, lbOpts, scalerParams, serverCapacity, serverParams,
} from './shared'
import { defaults, isActive, type Params } from './types'

const base: Params = { ...defaults(serverParams) }

describe('instanceOpts: worker pool sizing', () => {
  test('worker pool is sized to the explicit workers knob (default 40)', () => {
    const o = instanceOpts({ ...base, cores: 4, cpuTimeMs: 10, ioWaitMs: 90 }, new Rng(1))
    expect(o.workerPool.slots).toBe(40)
  })

  test('workers is independent of cores — cores and concurrency are different knobs', () => {
    const few = instanceOpts({ ...base, cores: 16, workers: 2 }, new Rng(1))
    expect(few.workerPool.slots).toBe(2)
    expect(few.cpuPool.slots).toBe(16)
    const many = instanceOpts({ ...base, cores: 1, workers: 512 }, new Rng(1))
    expect(many.workerPool.slots).toBe(512)
    expect(many.cpuPool.slots).toBe(1)
  })

  test('unlimitedWorkers bypasses the formula with a large sentinel', () => {
    const o = instanceOpts({ ...base, cores: 4, cpuTimeMs: 10, ioWaitMs: 90, unlimitedWorkers: true }, new Rng(1))
    expect(o.workerPool.slots).toBeGreaterThan(1000)
  })

  test('cpuPool sized to cores', () => {
    const o = instanceOpts({ ...base, cores: 8 }, new Rng(1))
    expect(o.cpuPool.slots).toBe(8)
  })

  // Not in the brief's own test list, added after tracing a real bug it produces: instance.ts's
  // Pool defaults queueLimit to 0, so an un-set cpuPool.queueLimit means a request that already
  // cleared the (deliberately oversized) workerPool gets rejected outright the instant the cpu
  // core it needs is momentarily busy — negating the whole point of sizing workers above cores.
  // Confirmed empirically: cpu.test.ts's "stable base load" scenario went from ~0% to ~100%
  // failure without this. cpuPool must be able to queue up to the full worker envelope.
  test('cpuPool has a queueLimit so a busy core waits instead of rejecting mid-flight', () => {
    const o = instanceOpts({ ...base, cores: 4, cpuTimeMs: 10, ioWaitMs: 90 }, new Rng(1))
    expect(o.cpuPool.queueLimit).toBe(o.workerPool.slots)
  })

  test('queueSlots maps to workerPool.queueLimit', () => {
    const o = instanceOpts({ ...base, queueSlots: 40 }, new Rng(1))
    expect(o.workerPool.queueLimit).toBe(40)
  })

  test('io pool is sized to the worker pool, so it is never the bottleneck', () => {
    const o = instanceOpts({ ...base, workers: 37 }, new Rng(1))
    expect(o.instancePools!.io!.slots).toBe(37)
    expect(o.instancePools!.io!.slots).toBe(o.workerPool.slots)
  })

  test('unlimitedWorkers ignores the workers knob and uses the sentinel', () => {
    const o = instanceOpts({ ...base, workers: 1, unlimitedWorkers: true }, new Rng(1))
    expect(o.workerPool.slots).toBeGreaterThan(1000)
    expect(o.instancePools!.io!.slots).toBe(o.workerPool.slots)
  })

  test('poisonProb maps to workerPool.poisonProb', () => {
    const o = instanceOpts({ ...base, poisonProb: 0.01 }, new Rng(1))
    expect(o.workerPool.poisonProb).toBe(0.01)
  })
})

describe('instanceOpts: step plan', () => {
  // Step.duration is a raw sim-time value and the sim's base unit is seconds (see bootSec, and the
  // old serviceTime: () => rng.exp(1000 / latencyMs), mean = latencyMs / 1000 s) — cpuTimeMs/ioWaitMs
  // are authored in milliseconds, so the sampled draw must be divided by 1000 before going into a
  // Step. (The field used to be called `ms`, which invited exactly the undivided-milliseconds bug:
  // a request would hold its worker/cpu slot for whole seconds instead of milliseconds, saturating
  // the derived pool sizes almost immediately — cpu.test.ts's "stable base load" scenario went from
  // ~0% to ~100% failure. Renamed to `duration` so the name no longer says the wrong unit.)
  test('default plan is one io step then one cpu step, sampled via the given rng', () => {
    const o = instanceOpts({ ...base, cpuTimeMs: 5, ioWaitMs: 20 }, new Rng(1))
    const plan = o.steps!()
    expect(plan.map((s) => [s.pool, s.scope])).toEqual([['io', 'instance'], ['cpu', 'instance']])
    expect(plan[0]!.duration).toBe(20 / 1000)
    expect(plan[1]!.duration).toBe(5 / 1000)
  })
})

describe('serverCapacity', () => {
  test('cores * 1000 / cpuTimeMs — the CPU-bound ceiling', () => {
    expect(serverCapacity({ ...base, cores: 4, cpuTimeMs: 20 })).toBe(4 * 1000 / 20)
  })
})

describe('shared DB pool (dbPoolSlots)', () => {
  test('dbPoolSlots 0 (default): clusterOpts has no clusterPools, instanceOpts has a 2-step plan', () => {
    const o = clusterOpts({ ...base, dbPoolSlots: 0 })
    expect(o.clusterPools).toBeUndefined()
    const io = instanceOpts({ ...base, dbPoolSlots: 0 }, new Rng(1))
    expect(io.steps!().map((s) => s.pool)).toEqual(['io', 'cpu'])
  })

  test('dbPoolSlots > 0: clusterOpts defines a db pool, instanceOpts inserts a cluster-scoped db step', () => {
    const o = clusterOpts({ ...base, dbPoolSlots: 5 })
    expect(o.clusterPools).toEqual({ db: { slots: 5, queueLimit: 1000 } })
    const io = instanceOpts({ ...base, dbPoolSlots: 5, dbQueryMs: 30 }, new Rng(1))
    const steps = io.steps!()
    expect(steps.map((s) => [s.pool, s.scope])).toEqual([['io', 'instance'], ['db', 'cluster'], ['cpu', 'instance']])
    expect(steps[1]!.duration).toBeCloseTo(0.03) // 30ms -> seconds
  })
})

describe('attachController: multi-metric wiring', () => {
  function setup(sim: Sim, overrides: Partial<Params> = {}) {
    // bootSec: 0 and healthCheckSec: 0 keep timing deterministic and instant, so tests only need
    // to wait out hpaReadinessDelaySec + a couple of metric scrapes, not a realistic boot/LB delay.
    const p = { ...base, ...defaults(scalerParams), bootSec: 0, healthCheckSec: 0, ...overrides }
    const lb = new LoadBalancer(sim, lbOpts(p))
    const cluster = new Cluster(sim, lb, instanceOpts(p, new Rng(1)), clusterOpts(p))
    cluster.scaleTo(2)
    const stats = new Stats(sim)
    return { p, lb, cluster, stats }
  }

  test('default (only metricCpu on): controller scales up under real overload, same as a single-CPU-metric HPA always has', () => {
    const sim = new Sim()
    const { p, lb, cluster, stats } = setup(sim, { maxInstances: 20 })
    attachController(sim, cluster, p, stats)
    // Massively overload the 2-pod cluster's CPU capacity so the CPU metric reads well above
    // its default target (0.5) almost immediately.
    const overload = serverCapacity(p) * 10
    new Arrivals(sim, new Rng(2), constant(overload), (r) => lb.handle(r)).start()
    sim.run(120) // past hpaReadinessDelaySec (30s) and a couple of metricsResolutionSec scrapes
    expect(cluster.size).toBeGreaterThan(2)
  })

  test('multiple metrics toggled on: Hpa receives all of them and scales on whichever needs it most (4zw)', () => {
    const sim = new Sim()
    const { p, lb, cluster, stats } = setup(sim, { metricCpu: true, metricRps: true, maxInstances: 20 })
    attachController(sim, cluster, p, stats)
    // 2 pods at ~75rps each: well above the rps target (50/pod, ratio 1.5) but only ~19% CPU
    // (75 * cpuTimeMs(10ms) / 4 cores ≈ 0.19), nowhere near the cpu target (0.5). If Hpa only
    // received the cpu metric (the multi-metric wiring silently dropped rps), this would never
    // scale; taking the max across both metrics means the rps metric alone must drive it.
    new Arrivals(sim, new Rng(2), constant(150), (r) => lb.handle(r)).start()
    sim.run(120)
    expect(cluster.size).toBeGreaterThan(2)
  })

  test('nothing toggled on: falls back to CPU only, and still scales under CPU overload', () => {
    const sim = new Sim()
    const { p, lb, cluster, stats } = setup(sim, { metricCpu: false, maxInstances: 20 })
    attachController(sim, cluster, p, stats)
    const overload = serverCapacity(p) * 10
    new Arrivals(sim, new Rng(2), constant(overload), (r) => lb.handle(r)).start()
    sim.run(120)
    expect(cluster.size).toBeGreaterThan(2)
  })

  test('AWS step scaling: non-utilization metric (rps) never breaches when load is well under its own target (7wg)', () => {
    const sim = new Sim()
    // rps target defaults to 50/pod; 2 pods at 20rps total is ~10rps/pod, well under target.
    // Before the fix, awsOutThreshold (a raw 0-1 fraction, e.g. 0.6) was compared directly
    // against the rps metric (tens of req/s) instead of being scaled to the metric's own
    // target, so it always breached and the cluster scaled out regardless of real load.
    const { p, lb, cluster, stats } = setup(sim, {
      algo: 'aws-step', metricCpu: false, metricRps: true, maxInstances: 20, baseRps: 20, rps: 20,
    })
    attachController(sim, cluster, p, stats)
    new Arrivals(sim, new Rng(2), constant(20), (r) => lb.handle(r)).start()
    sim.run(900)
    expect(cluster.size).toBe(2)
  })

  test('AWS algo: with several metrics toggled, picks the first in METRIC_IDS order — cpu over rps (4zw)', () => {
    const sim = new Sim()
    // Both cpu (default on) and rps toggled: cpu comes first in METRIC_IDS, so AWS should attach
    // to it and ignore rps entirely, regardless of toggle order in the overrides object.
    const { p, cluster, stats } = setup(sim, { algo: 'aws-target', metricCpu: true, metricRps: true })
    const c = attachController(sim, cluster, p, stats)
    expect(c.metricKind).toBe('utilization') // cpu's kind, not rps's ('absolute')
  })

  test('AWS algo: controller.metricKind reflects the attached metric, not a hardcoded utilization (ddx)', () => {
    const sim = new Sim()
    const { p, cluster, stats } = setup(sim, { algo: 'aws-target', metricCpu: false, metricRps: true })
    const c = attachController(sim, cluster, p, stats)
    expect(c.metricKind).toBe('absolute')
  })
})

describe('metricQueue param: hidden when unlimitedWorkers makes it structurally zero (too)', () => {
  const queueToggle = scalerParams.find((s) => s.key === 'metricQueue')!
  const queueTarget = scalerParams.find((s) => s.key === 'metricQueueTarget')!

  test('visible with bounded worker pool', () => {
    expect(isActive(queueToggle, { ...base, unlimitedWorkers: false })).toBe(true)
  })

  test('hidden once unlimitedWorkers is on — nothing ever queues', () => {
    expect(isActive(queueToggle, { ...base, unlimitedWorkers: true })).toBe(false)
    expect(isActive(queueTarget, { ...base, metricQueue: true, unlimitedWorkers: true })).toBe(false)
  })
})
