// presentation/sim/scenarios/shared.test.ts
import { describe, expect, test } from 'vitest'
import { Rng } from '../rng'
import { instanceOpts, unitCapacity, unitParams } from './shared'
import { defaults, type Params } from './types'

const base: Params = { ...defaults(unitParams) }

describe('instanceOpts: worker pool sizing', () => {
  test('Nworkers = cores * (cpu + io) / cpu, ceiled', () => {
    const o = instanceOpts({ ...base, cores: 4, cpuTimeMs: 10, ioWaitMs: 90 }, new Rng(1))
    expect(o.workerPool.slots).toBe(Math.ceil(4 * (10 + 90) / 10)) // 40
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

  test('io pool is sized to the worker pool, so it is never the bottleneck — even past the unlimited sentinel', () => {
    const derived = instanceOpts({ ...base, cores: 64, cpuTimeMs: 1, ioWaitMs: 2000 }, new Rng(1))
    expect(derived.workerPool.slots).toBe(64 * 2001) // far more than the unlimited sentinel
    expect(derived.instancePools!.io!.slots).toBe(derived.workerPool.slots)
    const unlimited = instanceOpts({ ...base, unlimitedWorkers: true }, new Rng(1))
    expect(unlimited.instancePools!.io!.slots).toBe(unlimited.workerPool.slots)
  })

  test('unlimitedWorkers never yields fewer workers than the derived size', () => {
    const o = instanceOpts({ ...base, cores: 64, cpuTimeMs: 1, ioWaitMs: 2000, unlimitedWorkers: true }, new Rng(1))
    expect(o.workerPool.slots).toBe(64 * 2001)
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
