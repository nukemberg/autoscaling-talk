import { describe, expect, test } from 'vitest'
import { Sim } from './engine'
import { Instance, type InstanceOpts } from './instance'
import { LoadBalancer } from './lb'
import { flatOpts } from './test-helpers'
import type { Request } from './types'

const base: InstanceOpts = flatOpts({ bootTime: 0, serviceTime: () => 1, concurrency: 1, queueLimit: 0 })

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
    const a = inst({ workerPool: { slots: 10 }, cpuPool: { slots: 10 } }), b = inst({ workerPool: { slots: 10 }, cpuPool: { slots: 10 } })
    for (let i = 0; i < 4; i++) lb.handle({ id: i, arrivedAt: 0 })
    expect(a.inFlight).toBe(2)
    expect(b.inFlight).toBe(2)
  })

  test('booting instances are not routed to', () => {
    const sim = new Sim()
    const { lb, inst, done } = setup(sim)
    const ready = inst({ workerPool: { slots: 10 }, cpuPool: { slots: 10 } })
    inst({ bootTime: 100, workerPool: { slots: 10 }, cpuPool: { slots: 10 } })
    for (let i = 0; i < 4; i++) lb.handle({ id: i, arrivedAt: 0 })
    expect(ready.inFlight).toBe(4)
    expect(done).toHaveLength(0)
  })

  test('least-conn picks the least loaded instance', () => {
    const sim = new Sim()
    const { lb, inst } = setup(sim, { policy: 'least-conn' })
    const a = inst({ workerPool: { slots: 10 }, cpuPool: { slots: 10 } }), b = inst({ workerPool: { slots: 10 }, cpuPool: { slots: 10 } })
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
    const a = inst({ workerPool: { slots: 10 }, cpuPool: { slots: 10 } }), b = inst({ workerPool: { slots: 10 }, cpuPool: { slots: 10 } })
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
    const a = inst({ bootTime: 3, workerPool: { slots: 10 }, cpuPool: { slots: 10 } })
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
    const a = inst({ workerPool: { slots: 10 }, cpuPool: { slots: 10 } })
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

describe('LoadBalancer health checks', () => {
  test('hung instance leaves rotation after unhealthyAfter consecutive failed checks', () => {
    const sim = new Sim()
    const { lb, inst } = setup(sim, { healthCheck: { interval: 10, unhealthyAfter: 3 } })
    const a = inst({ workerPool: { slots: 10 }, cpuPool: { slots: 10 } })
    sim.run(10)
    expect(lb.readyCount).toBe(1)
    a.hang(100)
    sim.run(30)                      // checks at 20, 30 fail → still in
    expect(lb.readyCount).toBe(1)
    sim.run(40)                      // third failure
    expect(lb.readyCount).toBe(0)
  })

  test('recovered instance rejoins after healthyAfter consecutive passes', () => {
    const sim = new Sim()
    const { lb, inst } = setup(sim, { healthCheck: { interval: 10, unhealthyAfter: 1, healthyAfter: 2 } })
    const a = inst({ workerPool: { slots: 10 }, cpuPool: { slots: 10 } })
    sim.run(10)
    a.hang(15)                       // hung until 25
    sim.run(20)
    expect(lb.readyCount).toBe(0)
    sim.run(30)                      // one pass
    expect(lb.readyCount).toBe(0)
    sim.run(40)                      // two passes
    expect(lb.readyCount).toBe(1)
  })

  test('defaults: unhealthyAfter 1, healthyAfter 1', () => {
    const sim = new Sim()
    const { lb, inst } = setup(sim, { healthCheck: { interval: 10 } })
    const a = inst({ workerPool: { slots: 10 }, cpuPool: { slots: 10 } })
    sim.run(10)
    a.hang(15)
    sim.run(20)
    expect(lb.readyCount).toBe(0)
    sim.run(30)
    expect(lb.readyCount).toBe(1)
  })

  test('default timeout is 0: a hung instance fails the very check tick that finds it hung', () => {
    const sim = new Sim()
    const { lb, inst } = setup(sim, { healthCheck: { interval: 10 } })
    const a = inst({ workerPool: { slots: 10 }, cpuPool: { slots: 10 } })
    sim.run(10)
    a.hang(100)
    sim.run(20) // one check tick after the hang starts
    expect(lb.readyCount).toBe(0)
  })

  test('connection-refused (not ready) fails instantly, ignoring timeout', () => {
    const sim = new Sim()
    const { lb, inst, done } = setup(sim, { healthCheck: { interval: 10, timeout: 100 } })
    const a = inst({ workerPool: { slots: 10 }, cpuPool: { slots: 10 } })
    sim.run(10)
    a.terminate()
    sim.run(20) // one check tick after termination — a huge timeout must not delay this
    expect(lb.readyCount).toBe(0)
    lb.handle({ id: 0, arrivedAt: 20 })
    expect(done[0].outcome).toBe('rejected')
  })

  test('hung instance: failure is registered only after the configured timeout elapses', () => {
    const sim = new Sim()
    const { lb, inst } = setup(sim, { healthCheck: { interval: 10, timeout: 5 } })
    const a = inst({ workerPool: { slots: 10 }, cpuPool: { slots: 10 } })
    sim.run(10)
    a.hang(100)
    sim.run(20) // check tick at 20 finds it hung; probe won't resolve until 25
    expect(lb.readyCount).toBe(1) // still routable — the probe hasn't timed out yet
    sim.run(25)
    expect(lb.readyCount).toBe(0) // now the timeout has elapsed
  })

  test('instance that recovers before the probe times out still counts as a pass', () => {
    const sim = new Sim()
    const { lb, inst } = setup(sim, { healthCheck: { interval: 10, timeout: 8 } })
    const a = inst({ workerPool: { slots: 10 }, cpuPool: { slots: 10 } })
    sim.run(10)
    a.hang(12) // hung until 22 — still hung when the check at 20 fires, recovers before the probe's timeout at 28
    sim.run(20)
    expect(lb.readyCount).toBe(1) // check at 20 sees it hung, probe scheduled for 28
    sim.run(28)
    expect(lb.readyCount).toBe(1) // by 28 it had long since recovered — the delayed re-read passes
  })
})
