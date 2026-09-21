import { describe, expect, test } from 'vitest'
import { Sim } from './engine'
import { Instance, type InstanceOpts } from './instance'
import { LoadBalancer } from './lb'
import type { Request } from './types'

const base: InstanceOpts = { bootTime: 0, serviceTime: () => 1, concurrency: 1, queueLimit: 0 }

function setup(sim: Sim, lbOpts: ConstructorParameters<typeof LoadBalancer>[1] = {}) {
  const done: Request[] = []
  const lb = new LoadBalancer(sim, lbOpts)
  lb.onDone = (r) => { done.push(r) }
  const inst = (over: Partial<InstanceOpts> = {}) => {
    const i = new Instance(sim, { ...base, ...over })
    lb.add(i)
    return i
  }
  return { lb, done, inst }
}

describe('LoadBalancer', () => {
  test('no instances → rejected', () => {
    const sim = new Sim()
    const { lb, done } = setup(sim)
    lb.handle({ id: 0, arrivedAt: 0 })
    expect(done[0].outcome).toBe('rejected')
  })

  test('round-robin spreads requests across ready instances', () => {
    const sim = new Sim()
    const { lb, inst } = setup(sim)
    const a = inst({ concurrency: 10 }), b = inst({ concurrency: 10 })
    for (let i = 0; i < 4; i++) lb.handle({ id: i, arrivedAt: 0 })
    expect(a.inFlight).toBe(2)
    expect(b.inFlight).toBe(2)
  })

  test('booting instances are not routed to', () => {
    const sim = new Sim()
    const { lb, inst, done } = setup(sim)
    const ready = inst({ concurrency: 10 })
    inst({ bootTime: 100, concurrency: 10 })
    for (let i = 0; i < 4; i++) lb.handle({ id: i, arrivedAt: 0 })
    expect(ready.inFlight).toBe(4)
    expect(done).toHaveLength(0)
  })

  test('least-conn picks the least loaded instance', () => {
    const sim = new Sim()
    const { lb, inst } = setup(sim, { policy: 'least-conn' })
    const a = inst({ concurrency: 10 }), b = inst({ concurrency: 10 })
    a.handle({ id: 100, arrivedAt: 0 })
    a.handle({ id: 101, arrivedAt: 0 })
    lb.handle({ id: 0, arrivedAt: 0 })
    lb.handle({ id: 1, arrivedAt: 0 })
    expect(b.inFlight).toBe(2)
    expect(a.inFlight).toBe(2)
  })

  test('remove takes instance out of rotation without terminating it', () => {
    const sim = new Sim()
    const { lb, inst } = setup(sim)
    const a = inst({ concurrency: 10 }), b = inst({ concurrency: 10 })
    lb.remove(a)
    for (let i = 0; i < 3; i++) lb.handle({ id: i, arrivedAt: 0 })
    expect(a.inFlight).toBe(0)
    expect(b.inFlight).toBe(3)
    expect(a.state).toBe('ready')
    expect(lb.size).toBe(1)
  })

  test('completed requests flow to lb.onDone with outcome', () => {
    const sim = new Sim()
    const { lb, inst, done } = setup(sim)
    inst()
    lb.handle({ id: 0, arrivedAt: 0 })
    sim.run()
    expect(done[0]).toMatchObject({ id: 0, outcome: 'ok', doneAt: 1 })
  })

  test('with healthCheck interval, a booted instance joins rotation only at the next check', () => {
    const sim = new Sim()
    const { lb, inst } = setup(sim, { healthCheck: { interval: 10 } })
    const a = inst({ bootTime: 3, concurrency: 10 })
    sim.run(5)
    lb.handle({ id: 0, arrivedAt: 5 })
    expect(a.inFlight).toBe(0) // ready but not yet seen by health check
    sim.run(10)
    lb.handle({ id: 1, arrivedAt: 10 })
    expect(a.inFlight).toBe(1)
  })

  test('with healthCheck interval, a terminated instance keeps receiving (and failing) until next check', () => {
    const sim = new Sim()
    const { lb, inst, done } = setup(sim, { healthCheck: { interval: 10 } })
    const a = inst({ concurrency: 10 })
    sim.run(10)
    a.terminate()
    lb.handle({ id: 0, arrivedAt: 10 })
    expect(done[0].outcome).toBe('rejected')
    sim.run(20)
    expect(lb.readyCount).toBe(0)
  })

  test('readyCount counts routable instances', () => {
    const sim = new Sim()
    const { lb, inst } = setup(sim)
    inst()
    inst({ bootTime: 5 })
    expect(lb.readyCount).toBe(1)
    sim.run(5)
    expect(lb.readyCount).toBe(2)
  })
})
