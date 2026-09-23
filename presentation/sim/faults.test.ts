import { describe, expect, test } from 'vitest'
import { Cluster } from './cluster'
import { Sim } from './engine'
import { injectFaults, type Fault } from './faults'
import { LoadBalancer } from './lb'
import { flatOpts } from './test-helpers'
import { Upstream } from './upstream'

function setup(sim: Sim, n = 6) {
  const lb = new LoadBalancer(sim)
  const cluster = new Cluster(sim, lb, flatOpts({ bootTime: 0, serviceTime: () => 1, concurrency: 4, queueLimit: 0 }))
  cluster.scaleTo(n)
  const upstream = new Upstream(sim, { capacity: 10, serviceTime: () => 1, queueLimit: 10 })
  return { lb, cluster, upstream }
}

describe('injectFaults', () => {
  test('kill: count instances crash at t', () => {
    const sim = new Sim()
    const { cluster } = setup(sim)
    injectFaults(sim, { cluster }, [{ kind: 'kill', at: 10, count: 2 }])
    sim.run(9)
    expect(cluster.size).toBe(6)
    sim.run(10)
    expect(cluster.size).toBe(4)
    expect(cluster.terminated).toBe(2)
  })

  test('kill: fraction of current size, at least 1', () => {
    const sim = new Sim()
    const { cluster } = setup(sim)
    injectFaults(sim, { cluster }, [{ kind: 'kill', at: 10, fraction: 0.5 }])
    sim.run(10)
    expect(cluster.size).toBe(3)
    const sim2 = new Sim()
    const c2 = setup(sim2, 1).cluster
    injectFaults(sim2, { cluster: c2 }, [{ kind: 'kill', at: 10, fraction: 0.1 }])
    sim2.run(10)
    expect(c2.size).toBe(0)
  })

  test('hang: instances hang for duration', () => {
    const sim = new Sim()
    const { cluster } = setup(sim)
    injectFaults(sim, { cluster }, [{ kind: 'hang', at: 10, count: 2, duration: 30 }])
    sim.run(10)
    expect(cluster.instances.filter((i) => i.hung)).toHaveLength(2)
    sim.run(40)
    expect(cluster.instances.filter((i) => i.hung)).toHaveLength(0)
  })

  test('slow: instances serve slower for duration', () => {
    const sim = new Sim()
    const { cluster } = setup(sim)
    injectFaults(sim, { cluster }, [{ kind: 'slow', at: 10, count: 1, duration: 30, factor: 4 }])
    sim.run(10)
    const slowed = cluster.instances[0]
    const done: number[] = []
    slowed.onDone = (r) => done.push(r.doneAt!)
    slowed.handle({ id: 0, arrivedAt: 10 })
    sim.run()
    expect(done).toEqual([14])
  })

  test('kill picks the oldest instances (ones actually serving)', () => {
    const sim = new Sim()
    const { cluster } = setup(sim, 2)
    const oldest = cluster.instances[0]
    injectFaults(sim, { cluster }, [{ kind: 'kill', at: 1, count: 1 }])
    sim.run(1)
    expect(oldest.state).toBe('terminated')
  })

  test('rollingRestart: replaces `batch` instances every `interval` until all are new', () => {
    const sim = new Sim()
    const lb = new LoadBalancer(sim)
    // replaceDeadAfter must not double-launch during a deploy
    const cluster = new Cluster(sim, lb, flatOpts({ bootTime: 5, serviceTime: () => 1, concurrency: 4, queueLimit: 0 }), { replaceDeadAfter: 1 })
    cluster.scaleTo(4)
    sim.run(5)
    const original = [...cluster.instances]
    injectFaults(sim, { cluster }, [{ kind: 'rollingRestart', at: 10, batch: 2, interval: 20 }])
    sim.run(10)
    expect(cluster.size).toBe(4)                       // batch replaced: 2 old + 2 booting
    expect(cluster.instances.filter((i) => original.includes(i))).toHaveLength(2)
    sim.run(30)
    expect(cluster.instances.filter((i) => original.includes(i))).toHaveLength(0)
    expect(cluster.launched).toBe(8)
  })

  test('upstreamOutage / upstreamSlow act on the upstream', () => {
    const sim = new Sim()
    const { cluster, upstream } = setup(sim)
    injectFaults(sim, { cluster, upstream }, [
      { kind: 'upstreamOutage', at: 10, duration: 5 },
      { kind: 'upstreamSlow', at: 20, duration: 5, factor: 3 },
    ])
    sim.run(10)
    expect(upstream.state).toBe('down')
    sim.run(15)
    expect(upstream.state).toBe('up')
    sim.run(20)
    const t: number[] = []
    upstream.call(() => t.push(sim.now))
    sim.run()
    expect(t).toEqual([23])
  })

  test('upstream faults without an upstream throw at injection time', () => {
    const sim = new Sim()
    const { cluster } = setup(sim)
    const faults: Fault[] = [{ kind: 'upstreamOutage', at: 1, duration: 1 }]
    expect(() => injectFaults(sim, { cluster }, faults)).toThrow(/upstream/)
  })
})
