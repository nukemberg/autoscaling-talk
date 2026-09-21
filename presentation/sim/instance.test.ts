import { describe, expect, test } from 'vitest'
import { Sim } from './engine'
import { Instance } from './instance'
import type { Request } from './types'

function req(sim: Sim, id = 0): Request {
  return { id, arrivedAt: sim.now }
}

function make(sim: Sim, over: Partial<ConstructorParameters<typeof Instance>[1]> = {}) {
  const done: Request[] = []
  const inst = new Instance(sim, {
    bootTime: 0,
    serviceTime: () => 1,
    concurrency: 1,
    queueLimit: 0,
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
    const { inst, done } = make(sim, { concurrency: 1, queueLimit: 5, serviceTime: () => 10 })
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
  test('serves request: startedAt, doneAt = start + serviceTime, outcome ok', () => {
    const sim = new Sim()
    const { inst, done } = make(sim, { serviceTime: () => 2 })
    sim.run(1)
    inst.handle(req(sim))
    sim.run()
    expect(done).toHaveLength(1)
    expect(done[0]).toMatchObject({ startedAt: 1, doneAt: 3, outcome: 'ok' })
  })

  test('concurrency limit queues extra requests, serves them when a slot frees', () => {
    const sim = new Sim()
    const { inst, done } = make(sim, { concurrency: 2, queueLimit: 10, serviceTime: () => 1 })
    for (let i = 0; i < 3; i++) inst.handle(req(sim, i))
    expect(inst.inFlight).toBe(2)
    expect(inst.queued).toBe(1)
    sim.run()
    expect(done.map((r) => [r.id, r.startedAt, r.doneAt])).toEqual([[0, 0, 1], [1, 0, 1], [2, 1, 2]])
  })

  test('queueLimit exceeded → rejected immediately', () => {
    const sim = new Sim()
    const { inst, done } = make(sim, { concurrency: 1, queueLimit: 1 })
    inst.handle(req(sim, 0))
    inst.handle(req(sim, 1))
    inst.handle(req(sim, 2))
    expect(done.map((r) => [r.id, r.outcome])).toEqual([[2, 'rejected']])
  })

  test('utilization = inFlight / concurrency, busy is time-weighted', () => {
    const sim = new Sim()
    const { inst } = make(sim, { concurrency: 4, serviceTime: () => 2 })
    inst.handle(req(sim, 0))
    inst.handle(req(sim, 1))
    expect(inst.utilization).toBe(0.5)
    sim.run(4)
    expect(inst.utilization).toBe(0)
    expect(inst.busy.mean).toBeCloseTo(0.25) // 0.5 for 2 of 4 time units
  })

  test('slowdown multiplies service time as a function of inFlight', () => {
    const sim = new Sim()
    const { inst, done } = make(sim, {
      concurrency: 10,
      serviceTime: () => 1,
      slowdown: (n) => n, // service time scales with load
    })
    inst.handle(req(sim, 0)) // inFlight 1 → 1
    inst.handle(req(sim, 1)) // inFlight 2 → 2
    inst.handle(req(sim, 2)) // inFlight 3 → 3
    sim.run()
    expect(done.map((r) => r.doneAt)).toEqual([1, 2, 3])
  })

  test('custom work function replaces the default timed service', () => {
    const sim = new Sim()
    const { inst, done } = make(sim, {
      work: (_r, finish) => sim.schedule(7, () => finish('error')),
    })
    inst.handle(req(sim))
    sim.run()
    expect(done[0]).toMatchObject({ doneAt: 7, outcome: 'error' })
  })
})

describe('Instance faults', () => {
  test('hang: in-flight requests complete only after the hang ends', () => {
    const sim = new Sim()
    const { inst, done } = make(sim, { concurrency: 4, serviceTime: () => 2 })
    inst.handle(req(sim, 0))          // would finish at 2
    sim.run(1)
    inst.hang(10)                     // hung until 11
    sim.run()
    expect(done[0]).toMatchObject({ doneAt: 12, outcome: 'ok' }) // 1 s of service left after 11
  })

  test('hang: new requests are accepted into slots and finish after the hang + service', () => {
    const sim = new Sim()
    const { inst, done } = make(sim, { concurrency: 2, serviceTime: () => 1 })
    inst.hang(10)
    inst.handle(req(sim, 0))
    inst.handle(req(sim, 1))
    inst.handle(req(sim, 2))          // no slot, no queue → rejected now
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

  test('cpu: reports utilization normally, hungCpu while hung', () => {
    const sim = new Sim()
    const { inst } = make(sim, { concurrency: 4, serviceTime: () => 10, hungCpu: 0 })
    inst.handle(req(sim, 0))
    expect(inst.cpu).toBe(0.25)
    inst.hang(5)
    expect(inst.cpu).toBe(0)
    sim.run(5)
    expect(inst.cpu).toBe(0.25)
  })

  test('cpu: hungCpu defaults to utilization (slots busy)', () => {
    const sim = new Sim()
    const { inst } = make(sim, { concurrency: 4, serviceTime: () => 10 })
    inst.handle(req(sim, 0))
    inst.hang(5)
    expect(inst.cpu).toBe(0.25)
  })

  test('slow: service time multiplied for the duration', () => {
    const sim = new Sim()
    const { inst, done } = make(sim, { concurrency: 4, serviceTime: () => 1 })
    inst.slow(3, 10)
    inst.handle(req(sim, 0))
    sim.run(10)
    inst.handle(req(sim, 1))
    sim.run()
    expect(done.map((r) => r.doneAt)).toEqual([3, 11])
  })

  test('booting instance is not healthy', () => {
    const sim = new Sim()
    const { inst } = make(sim, { bootTime: 5 })
    expect(inst.healthy).toBe(false)
  })
})
