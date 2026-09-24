// presentation/sim/scenarios/shared.test.ts
import { describe, expect, test } from 'vitest'
import { Rng } from '../rng'
import { clusterOpts, instanceOpts, unitCapacity, unitParams } from './shared'
import { defaults, type Params } from './types'

const base: Params = { ...defaults(unitParams) }

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

describe('unitCapacity', () => {
  test('cores * 1000 / cpuTimeMs — the CPU-bound ceiling', () => {
    expect(unitCapacity({ ...base, cores: 4, cpuTimeMs: 20 })).toBe(4 * 1000 / 20)
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
