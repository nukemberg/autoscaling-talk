// presentation/sim/instance.test.ts
import { describe, expect, test } from 'vitest'
import { Sim } from './engine'
import { Instance, type InstanceOpts, type Step } from './instance'
import { Pool } from './pool'
import type { Outcome, Request } from './types'

function req(sim: Sim, id = 0): Request {
  return { id, arrivedAt: sim.now }
}

function cpuStep(ms: number): Step {
  return { pool: 'cpu', scope: 'instance', ms }
}

function make(sim: Sim, over: Partial<InstanceOpts> = {}) {
  const done: Request[] = []
  const inst = new Instance(sim, {
    bootTime: 0,
    workerPool: { slots: 1 },
    cpuPool: { slots: 1 },
    steps: () => [cpuStep(1)],
    ...over,
  })
  inst.onDone = (r) => { done.push(r) }
  return { inst, done }
}

describe('Instance lifecycle', () => {
  test('boots after bootTime, then is ready', () => {
    const sim = new Sim()
    const { inst } = make(sim, { bootTime: 5 })
    expect(inst.state).toBe('booting')
    sim.run(4.9)
    expect(inst.state).toBe('booting')
    sim.run(5)
    expect(inst.state).toBe('ready')
  })

  test('bootTime may be a sampler', () => {
    const sim = new Sim()
    const { inst } = make(sim, { bootTime: () => 3 })
    sim.run(3)
    expect(inst.state).toBe('ready')
  })

  test('request during boot is rejected', () => {
    const sim = new Sim()
    const { inst, done } = make(sim, { bootTime: 5 })
    inst.handle(req(sim))
    expect(done[0].outcome).toBe('rejected')
    expect(done[0].doneAt).toBe(0)
  })

  test('terminate kills in-flight and queued requests with error', () => {
    const sim = new Sim()
    const { inst, done } = make(sim, {
      workerPool: { slots: 1, queueLimit: 5 }, cpuPool: { slots: 1 }, steps: () => [cpuStep(10)],
    })
    sim.run(0)
    inst.handle(req(sim, 1))
    inst.handle(req(sim, 2))
    sim.run(3)
    inst.terminate()
    expect(inst.state).toBe('terminated')
    expect(done.map((r) => [r.id, r.outcome, r.doneAt])).toEqual([[1, 'error', 3], [2, 'error', 3]])
    inst.handle(req(sim, 3))
    expect(done[2].outcome).toBe('rejected')
  })

  test('terminate during boot leaves no ready transition', () => {
    const sim = new Sim()
    const { inst } = make(sim, { bootTime: 5 })
    sim.run(1)
    inst.terminate()
    sim.run(10)
    expect(inst.state).toBe('terminated')
  })
})

describe('Instance service', () => {
  test('serves request: startedAt, doneAt = start + step ms, outcome ok', () => {
    const sim = new Sim()
    const { inst, done } = make(sim, { steps: () => [cpuStep(2)] })
    sim.run(1)
    inst.handle(req(sim))
    sim.run()
    expect(done).toHaveLength(1)
    expect(done[0]).toMatchObject({ startedAt: 1, doneAt: 3, outcome: 'ok' })
  })

  test('multi-step plan runs steps in order, latency is the sum', () => {
    const sim = new Sim()
    const { inst, done } = make(sim, {
      cpuPool: { slots: 1 },
      instancePools: { io: { slots: 5 } },
      steps: () => [{ pool: 'io', scope: 'instance', ms: 3 }, cpuStep(2)],
    })
    inst.handle(req(sim))
    sim.run()
    expect(done[0]).toMatchObject({ doneAt: 5, outcome: 'ok' })
  })

  test('worker pool queues extra requests, serves them when a slot frees', () => {
    const sim = new Sim()
    const { inst, done } = make(sim, {
      workerPool: { slots: 2, queueLimit: 10 }, cpuPool: { slots: 2 }, steps: () => [cpuStep(1)],
    })
    for (let i = 0; i < 3; i++) inst.handle(req(sim, i))
    expect(inst.inFlight).toBe(2)
    expect(inst.queued).toBe(1)
    sim.run()
    expect(done.map((r) => [r.id, r.startedAt, r.doneAt])).toEqual([[0, 0, 1], [1, 0, 1], [2, 1, 2]])
  })

  test('worker queueLimit exceeded → rejected immediately', () => {
    const sim = new Sim()
    const { inst, done } = make(sim, { workerPool: { slots: 1, queueLimit: 1 } })
    inst.handle(req(sim, 0))
    inst.handle(req(sim, 1))
    inst.handle(req(sim, 2))
    expect(done.map((r) => [r.id, r.outcome])).toEqual([[2, 'rejected']])
  })

  test('a step whose pool is full and whose queue is also full rejects the whole request', () => {
    const sim = new Sim()
    const { inst, done } = make(sim, {
      workerPool: { slots: 2 }, cpuPool: { slots: 1, queueLimit: 0 }, steps: () => [cpuStep(10)],
    })
    inst.handle(req(sim, 0)) // takes the one cpu slot
    inst.handle(req(sim, 1)) // cpu full, no queue room → rejected, but still holds+releases its worker slot
    expect(done.map((r) => [r.id, r.outcome])).toEqual([[1, 'rejected']])
    expect(inst.inFlight).toBe(1) // request 0 still running; request 1's worker slot was released
  })

  test('a step queues for its pool: queueing time adds real latency', () => {
    const sim = new Sim()
    const { inst, done } = make(sim, {
      workerPool: { slots: 2 }, cpuPool: { slots: 1, queueLimit: 5 }, steps: () => [cpuStep(3)],
    })
    inst.handle(req(sim, 0))
    inst.handle(req(sim, 1)) // queues for the cpu slot for 3 units
    sim.run()
    expect(done.map((r) => [r.id, r.doneAt])).toEqual([[0, 3], [1, 6]])
  })

  test('custom work function replaces the default step pipeline', () => {
    const sim = new Sim()
    const { inst, done } = make(sim, {
      work: (_r, finish) => sim.schedule(7, () => finish('error')),
    })
    inst.handle(req(sim))
    sim.run()
    expect(done[0]).toMatchObject({ doneAt: 7, outcome: 'error' })
  })
})

describe('Instance worker poisoning', () => {
  test('poisonProb 1 retires the worker after one request; the next is rejected', () => {
    const sim = new Sim()
    const { inst, done } = make(sim, {
      // rollUniform defaults to 1, which never poisons even at poisonProb 1 (1 < 1 is
      // false) — that default is deliberately safe/inert; a real roll needs a real sampler.
      workerPool: { slots: 1, poisonProb: 1 }, steps: () => [cpuStep(1)], rollUniform: () => 0,
    })
    inst.handle(req(sim, 0))
    sim.run()
    inst.handle(req(sim, 1))
    expect(done.map((r) => [r.id, r.outcome])).toEqual([[0, 'ok'], [1, 'rejected']])
  })

  test('poisonProb 0 (default) never retires', () => {
    const sim = new Sim()
    const { inst, done } = make(sim, { workerPool: { slots: 1 }, steps: () => [cpuStep(1)] })
    for (let i = 0; i < 5; i++) { inst.handle(req(sim, i)); sim.run() }
    expect(done.every((r) => r.outcome === 'ok')).toBe(true)
  })

  test('rollUniform threads through: a roll below poisonProb retires, at/above does not', () => {
    const sim = new Sim()
    const rolls = [0.4, 0.6]
    let i = 0
    const { inst, done } = make(sim, {
      workerPool: { slots: 1, poisonProb: 0.5 }, steps: () => [cpuStep(1)],
      rollUniform: () => rolls[i++]!,
    })
    inst.handle(req(sim, 0)) // roll 0.4 < 0.5 → retired
    sim.run()
    inst.handle(req(sim, 1))
    expect(done.map((r) => [r.id, r.outcome])).toEqual([[0, 'ok'], [1, 'rejected']])
  })
})

describe('Instance cluster-scoped steps', () => {
  test('a cluster-scoped step acquires the shared Pool passed in via clusterPools', () => {
    const sim = new Sim()
    const db = new Pool(sim, { slots: 1, queueLimit: 1 }) // queueLimit: b must queue behind a rather than reject
    const { inst: a, done: doneA } = make(sim, {
      cpuPool: { slots: 1 }, clusterPools: { db }, steps: () => [{ pool: 'db', scope: 'cluster', ms: 5 }],
    })
    const { inst: b, done: doneB } = make(sim, {
      cpuPool: { slots: 1 }, clusterPools: { db }, steps: () => [{ pool: 'db', scope: 'cluster', ms: 5 }],
    })
    a.handle(req(sim, 0))
    b.handle(req(sim, 1)) // same shared db pool, only 1 slot → b queues behind a
    sim.run()
    expect(doneA[0]).toMatchObject({ doneAt: 5, outcome: 'ok' })
    expect(doneB[0]).toMatchObject({ doneAt: 10, outcome: 'ok' })
  })

  test('terminate releases a currently-held cluster-scoped slot back to the shared pool', () => {
    const sim = new Sim()
    const db = new Pool(sim, { slots: 1 })
    const { inst: a } = make(sim, {
      cpuPool: { slots: 1 }, clusterPools: { db }, steps: () => [{ pool: 'db', scope: 'cluster', ms: 100 }],
    })
    a.handle(req(sim, 0))
    expect(db.occupied).toBe(1)
    a.terminate()
    expect(db.occupied).toBe(0) // released back for other instances sharing this pool
  })
})

describe('Instance faults', () => {
  test('hang: in-flight requests complete only after the hang ends', () => {
    const sim = new Sim()
    const { inst, done } = make(sim, {
      workerPool: { slots: 4 }, cpuPool: { slots: 4 }, steps: () => [cpuStep(2)],
    })
    inst.handle(req(sim, 0)) // would finish at 2
    sim.run(1)
    inst.hang(10) // hung until 11
    sim.run()
    expect(done[0]).toMatchObject({ doneAt: 12, outcome: 'ok' }) // 1 unit of step left after 11
  })

  test('hang: new requests are accepted and finish after the hang + step', () => {
    const sim = new Sim()
    const { inst, done } = make(sim, {
      workerPool: { slots: 2 }, cpuPool: { slots: 2 }, steps: () => [cpuStep(1)],
    })
    inst.hang(10)
    inst.handle(req(sim, 0))
    inst.handle(req(sim, 1))
    inst.handle(req(sim, 2)) // no worker slot, no queue → rejected now
    expect(done.map((r) => [r.id, r.outcome, r.doneAt])).toEqual([[2, 'rejected', 0]])
    expect(inst.utilization).toBe(1)
    sim.run()
    expect(done.slice(1).map((r) => r.doneAt)).toEqual([11, 11])
  })

  test('hang: healthy is false while hung, true after', () => {
    const sim = new Sim()
    const { inst } = make(sim)
    expect(inst.healthy).toBe(true)
    inst.hang(5)
    expect(inst.healthy).toBe(false)
    sim.run(5)
    expect(inst.healthy).toBe(true)
  })

  test('cpu: reports the cpu pool busy fraction, hungCpu override while hung', () => {
    const sim = new Sim()
    const { inst } = make(sim, {
      workerPool: { slots: 4 }, cpuPool: { slots: 4 }, steps: () => [cpuStep(10)], hungCpu: 0,
    })
    inst.handle(req(sim, 0))
    expect(inst.cpu).toBe(0.25)
    inst.hang(5)
    expect(inst.cpu).toBe(0)
    sim.run(5)
    expect(inst.cpu).toBe(0.25)
  })

  test('cpu: hungCpu defaults to utilization (worker slots busy)', () => {
    const sim = new Sim()
    const { inst } = make(sim, {
      workerPool: { slots: 4 }, cpuPool: { slots: 4 }, steps: () => [cpuStep(10)],
    })
    inst.handle(req(sim, 0))
    inst.hang(5)
    expect(inst.cpu).toBe(0.25)
  })

  test('cpu with cores:1 is an honest event-loop-utilization metric', () => {
    const sim = new Sim()
    const { inst } = make(sim, {
      workerPool: { slots: 100 }, cpuPool: { slots: 1, queueLimit: 1 }, steps: () => [cpuStep(10)],
    })
    inst.handle(req(sim, 0))
    inst.handle(req(sim, 1)) // 2nd request's worker slot is held while it queues for the single cpu slot
    expect(inst.cpu).toBe(1) // the one core is fully busy, regardless of worker-pool size
    expect(inst.utilization).toBe(0.02) // 2 of 100 worker slots held — the honest concurrency picture
  })

  test('slow: multiplies instance-scoped step ms for new steps started during the fault', () => {
    const sim = new Sim()
    const { inst, done } = make(sim, {
      workerPool: { slots: 4 }, cpuPool: { slots: 4 }, steps: () => [cpuStep(1)],
    })
    inst.slow(3, 10)
    inst.handle(req(sim, 0))
    sim.run(10)
    inst.handle(req(sim, 1))
    sim.run()
    expect(done.map((r) => r.doneAt)).toEqual([3, 11])
  })

  test('slow does not multiply cluster-scoped steps', () => {
    const sim = new Sim()
    const db = new Pool(sim, { slots: 1 })
    const { inst, done } = make(sim, {
      cpuPool: { slots: 1 }, clusterPools: { db }, steps: () => [{ pool: 'db', scope: 'cluster', ms: 1 }],
    })
    inst.slow(3, 10)
    inst.handle(req(sim, 0))
    sim.run()
    expect(done[0]!.doneAt).toBe(1) // unaffected — a local-instance fault shouldn't inflate a shared upstream's time
  })

  test('booting instance is not healthy', () => {
    const sim = new Sim()
    const { inst } = make(sim, { bootTime: 5 })
    expect(inst.healthy).toBe(false)
  })
})

describe('Instance timestamps', () => {
  test('launchedAt and readySince', () => {
    const sim = new Sim()
    sim.run(3)
    const { inst } = make(sim, { bootTime: 5 })
    expect(inst.launchedAt).toBe(3)
    expect(inst.readySince).toBeUndefined()
    sim.run(8)
    expect(inst.readySince).toBe(8)
  })
})
