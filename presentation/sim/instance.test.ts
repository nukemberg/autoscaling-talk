// presentation/sim/instance.test.ts
import { describe, expect, test } from 'vitest'
import { Sim } from './engine'
import { Instance, type InstanceOpts, type Step } from './instance'
import { Pool } from './pool'
import type { Outcome, Request } from './types'

function req(sim: Sim, id = 0): Request {
  return { id, arrivedAt: sim.now }
}

function cpuStep(duration: number): Step {
  return { pool: 'cpu', scope: 'instance', duration }
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
  test('serves request: startedAt, doneAt = start + step duration, outcome ok', () => {
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
      steps: () => [{ pool: 'io', scope: 'instance', duration: 3 }, cpuStep(2)],
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

  test('an instancePools entry named "cpu" is rejected: that name is reserved for cpuPool', () => {
    const sim = new Sim()
    expect(() => make(sim, { instancePools: { cpu: { slots: 8 } } })).toThrow(/"cpu" is reserved/)
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
      cpuPool: { slots: 1 }, clusterPools: { db }, steps: () => [{ pool: 'db', scope: 'cluster', duration: 5 }],
    })
    const { inst: b, done: doneB } = make(sim, {
      cpuPool: { slots: 1 }, clusterPools: { db }, steps: () => [{ pool: 'db', scope: 'cluster', duration: 5 }],
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
      cpuPool: { slots: 1 }, clusterPools: { db }, steps: () => [{ pool: 'db', scope: 'cluster', duration: 100 }],
    })
    a.handle(req(sim, 0))
    expect(db.occupied).toBe(1)
    a.terminate()
    expect(db.occupied).toBe(0) // released back for other instances sharing this pool
  })

  // Regression for the terminate() ordering bug: releasing a held cluster slot
  // can synchronously cascade a grant to ANOTHER occupant of the SAME instance
  // (queued behind it for that same pool). If `occupants` isn't cleared first,
  // that occupant's holdStep sees itself as still alive and schedules a
  // completion nothing later cancels — a double-finish and negative occupancy
  // once that completion eventually fires.
  test('terminate while one occupant holds a shared cluster slot and another is queued for it: no double-finish, no negative occupancy, slot freed immediately', () => {
    const sim = new Sim()
    const db = new Pool(sim, { slots: 1, queueLimit: 5 })
    let call = 0
    const plans: Step[][] = [
      [cpuStep(5), { pool: 'db', scope: 'cluster', duration: 10 }], // req 0: cpu, then db
      [{ pool: 'db', scope: 'cluster', duration: 10 }], // req 1: db only — grabs the db slot immediately
    ]
    const { inst, done } = make(sim, {
      workerPool: { slots: 2 }, cpuPool: { slots: 1 }, clusterPools: { db },
      steps: () => plans[call++]!,
    })
    inst.handle(req(sim, 0))
    inst.handle(req(sim, 1))
    // t=5: req0 finishes its cpu step and queues behind req1 for the db slot.
    // t=6: terminate while req1 holds db and req0 is queued for it.
    sim.run(6)
    inst.terminate()
    expect(done.map((r) => [r.id, r.outcome, r.doneAt])).toEqual([[0, 'error', 6], [1, 'error', 6]])
    expect(db.occupied).toBe(0) // freed immediately, not after the held step's full duration
    sim.run() // nothing left to fire; if the bug were present, req0 would double-finish at t=16
    expect(done).toHaveLength(2)
    expect(inst.inFlight).toBe(0) // never goes negative
  })

  // Documents a real but narrow limitation: terminate() only forceResets
  // instance-scoped pools. A waiter this instance queued in a *shared* cluster
  // pool stays in that pool's FIFO queue — inert (the staleness guard in
  // holdStep no-ops it once reached) but still consuming `queueLimit` room
  // until the pool naturally reaches it.
  test('terminate does not remove a queued waiter from a shared cluster pool: inert but still consumes queue room until reached', () => {
    const sim = new Sim()
    const db = new Pool(sim, { slots: 1, queueLimit: 1 })
    const { inst: c } = make(sim, {
      cpuPool: { slots: 1 }, clusterPools: { db }, steps: () => [{ pool: 'db', scope: 'cluster', duration: 100 }],
    })
    const { inst: a, done: doneA } = make(sim, {
      cpuPool: { slots: 1 }, clusterPools: { db }, steps: () => [{ pool: 'db', scope: 'cluster', duration: 10 }],
    })
    const { inst: b, done: doneB } = make(sim, {
      cpuPool: { slots: 1 }, clusterPools: { db }, steps: () => [{ pool: 'db', scope: 'cluster', duration: 5 }],
    })

    c.handle(req(sim, 0)) // holds the only db slot until t=100
    a.handle(req(sim, 1)) // db full → queues (queueLimit 1, fits)
    sim.run(1)
    a.terminate() // a's queued waiter is NOT removed from db's queue
    expect(doneA.map((r) => [r.id, r.outcome])).toEqual([[1, 'error']])

    // db is still full (c) and its queue is spuriously full with a's dead
    // waiter, so a legitimate request from a different instance is rejected.
    b.handle(req(sim, 2))
    expect(doneB.map((r) => [r.id, r.outcome])).toEqual([[2, 'rejected']])

    sim.run() // t=100: c releases, cascades to a's dead waiter — inert, releases straight back
    expect(doneA).toHaveLength(1) // no second finish for a's dead waiter
    expect(db.occupied).toBe(0)
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

  test('hang mid-way through a multi-step plan: pushes out the in-progress step only; later steps run normally after', () => {
    const sim = new Sim()
    const { inst, done } = make(sim, {
      workerPool: { slots: 1 }, cpuPool: { slots: 1 }, instancePools: { io: { slots: 1 } },
      steps: () => [{ pool: 'io', scope: 'instance', duration: 3 }, cpuStep(2)],
    })
    inst.handle(req(sim, 0)) // io [0,3) then cpu [3,5) if nothing happened
    sim.run(1)
    inst.hang(10)            // hung until 11: io has 2 left → resumes to 13, then cpu 2 → 15
    sim.run()
    expect(done[0]).toMatchObject({ doneAt: 15, outcome: 'ok' })
    expect(inst.inFlight).toBe(0)
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

  test('cpuSeconds: cumulative ∫ cpu dt — a counter, not an instantaneous fraction', () => {
    const sim = new Sim()
    const { inst } = make(sim, {
      workerPool: { slots: 4 }, cpuPool: { slots: 1, queueLimit: 4 }, steps: () => [cpuStep(2)],
    })
    inst.handle(req(sim, 0))
    sim.run(1)
    expect(inst.cpuSeconds).toBeCloseTo(1) // mid-step: includes the in-progress segment
    sim.run(5)                             // busy [0,2), idle [2,5)
    expect(inst.cpuSeconds).toBeCloseTo(2)
    expect(inst.cpu).toBe(0)
    inst.handle(req(sim, 1))
    inst.handle(req(sim, 2))               // queues for the one core: busy [5,9)
    sim.run(10)
    expect(inst.cpuSeconds).toBeCloseTo(6)
  })

  test('cpuSeconds: advances at hungCpu while hung (the same lie `cpu` tells), honest again after', () => {
    const sim = new Sim()
    const { inst } = make(sim, {
      workerPool: { slots: 4 }, cpuPool: { slots: 4 }, steps: () => [cpuStep(100)], hungCpu: 1,
    })
    inst.handle(req(sim, 0))               // honest: 0.25
    sim.run(4)
    inst.hang(4)                           // hung [4,8)
    sim.run(6)
    inst.hang(4)                           // extended: hung [4,10)
    sim.run(10)
    expect(inst.cpuSeconds).toBeCloseTo(4 * 0.25 + 6 * 1)
    sim.run(14)
    expect(inst.cpuSeconds).toBeCloseTo(4 * 0.25 + 6 * 1 + 4 * 0.25)
  })

  test('cpuSeconds: while hung without hungCpu, advances at the worker pool busy fraction', () => {
    const sim = new Sim()
    const { inst } = make(sim, {
      workerPool: { slots: 2 }, cpuPool: { slots: 4 }, steps: () => [cpuStep(100)],
    })
    inst.handle(req(sim, 0))               // cpu 0.25, utilization 0.5
    inst.hang(10)
    sim.run(10)
    expect(inst.cpuSeconds).toBeCloseTo(10 * 0.5)
  })

  test('slow: multiplies instance-scoped step duration for new steps started during the fault', () => {
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
      cpuPool: { slots: 1 }, clusterPools: { db }, steps: () => [{ pool: 'db', scope: 'cluster', duration: 1 }],
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
