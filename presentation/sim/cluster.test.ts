import { describe, expect, test } from 'vitest'
import { Sim } from './engine'
import { Cluster } from './cluster'
import { LoadBalancer } from './lb'
import { Pool } from './pool'
import { flatOpts } from './test-helpers'

function setup(sim: Sim, boot = 5) {
  const lb = new LoadBalancer(sim)
  const cluster = new Cluster(sim, lb, flatOpts({ bootTime: boot, serviceTime: () => 1, concurrency: 1, queueLimit: 0 }))
  return { lb, cluster }
}

describe('Cluster', () => {
  test('starts empty', () => {
    const { cluster } = setup(new Sim())
    expect(cluster.size).toBe(0)
    expect(cluster.ready).toBe(0)
  })

  test('scaleTo(n) launches n booting instances registered with the LB', () => {
    const sim = new Sim()
    const { lb, cluster } = setup(sim)
    cluster.scaleTo(3)
    expect(cluster.size).toBe(3)
    expect(cluster.ready).toBe(0)
    expect(lb.size).toBe(3)
    sim.run(5)
    expect(cluster.ready).toBe(3)
  })

  test('scaleTo below size terminates youngest instances first and removes them from LB', () => {
    const sim = new Sim()
    const { lb, cluster } = setup(sim)
    cluster.scaleTo(2)
    sim.run(5)
    cluster.scaleTo(3)   // one booting
    const booting = cluster.instances.find((i) => i.state === 'booting')!
    cluster.scaleTo(1)
    expect(cluster.size).toBe(1)
    expect(lb.size).toBe(1)
    expect(booting.state).toBe('terminated')
    expect(cluster.instances[0].state).toBe('ready')
  })

  test('launched and terminated counters accumulate', () => {
    const sim = new Sim()
    const { cluster } = setup(sim)
    cluster.scaleTo(4)
    cluster.scaleTo(1)
    cluster.scaleTo(2)
    expect(cluster.launched).toBe(5)
    expect(cluster.terminated).toBe(3)
  })

  test('utilization = mean utilization over ready instances (0 if none)', () => {
    const sim = new Sim()
    const { lb, cluster } = setup(sim, 0)
    expect(cluster.utilization).toBe(0)
    cluster.scaleTo(2)
    lb.handle({ id: 0, arrivedAt: 0 })
    expect(cluster.utilization).toBe(0.5)
  })
})

describe('Cluster crash + replacement', () => {
  test('crash removes the instance from cluster and LB, fails its requests', () => {
    const sim = new Sim()
    const { lb, cluster } = setup(sim, 0)
    cluster.scaleTo(2)
    const victim = cluster.instances[0]
    const done: string[] = []
    lb.onDone = (r) => done.push(r.outcome!)
    victim.handle({ id: 0, arrivedAt: 0 })
    cluster.crash(victim)
    expect(cluster.size).toBe(1)
    expect(lb.size).toBe(1)
    expect(victim.state).toBe('terminated')
    expect(done).toEqual(['error'])
    expect(cluster.terminated).toBe(1)
  })

  test('with replaceDeadAfter, a replacement launches after the delay', () => {
    const sim = new Sim()
    const lb = new LoadBalancer(sim)
    const cluster = new Cluster(sim, lb, flatOpts({ bootTime: 5, serviceTime: () => 1, concurrency: 1, queueLimit: 0 }), { replaceDeadAfter: 30 })
    cluster.scaleTo(2)
    sim.run(5)
    cluster.crash(cluster.instances[0])
    expect(cluster.size).toBe(1)
    sim.run(34)
    expect(cluster.size).toBe(1)
    sim.run(35)
    expect(cluster.size).toBe(2)
    expect(cluster.ready).toBe(1)
    sim.run(40)
    expect(cluster.ready).toBe(2)
  })

  test('replacement is skipped if the cluster was scaled down meanwhile', () => {
    const sim = new Sim()
    const lb = new LoadBalancer(sim)
    const cluster = new Cluster(sim, lb, flatOpts({ bootTime: 0, serviceTime: () => 1, concurrency: 1, queueLimit: 0 }), { replaceDeadAfter: 30 })
    cluster.scaleTo(3)
    cluster.crash(cluster.instances[0])
    cluster.scaleTo(1)
    sim.run(60)
    expect(cluster.size).toBe(1)
  })

  test('cpu = mean reported cpu over ready instances (hung ones lie)', () => {
    const sim = new Sim()
    const lb = new LoadBalancer(sim)
    const cluster = new Cluster(sim, lb, flatOpts({ bootTime: 0, serviceTime: () => 10, concurrency: 2, queueLimit: 0, hungCpu: 1 }))
    cluster.scaleTo(2)
    cluster.instances[0].hang(10)
    expect(cluster.utilization).toBe(0)
    expect(cluster.cpu).toBe(0.5)
  })
})

describe('Cluster.clusterPools', () => {
  test('instances launched by the same cluster share the same Pool object', () => {
    const sim = new Sim()
    const lb = new LoadBalancer(sim)
    const opts = {
      ...flatOpts({ serviceTime: () => 0, concurrency: 1, queueLimit: 0 }),
      steps: () => [{ pool: 'db', scope: 'cluster' as const, ms: 5 }],
    }
    const cluster = new Cluster(sim, lb, opts, { clusterPools: { db: { slots: 1, queueLimit: 1 } } }) // queueLimit: b must queue behind a rather than reject
    cluster.scaleTo(2)
    const [a, b] = cluster.instances
    a!.handle({ id: 0, arrivedAt: sim.now })
    b!.handle({ id: 1, arrivedAt: sim.now }) // same shared db pool, 1 slot → queues behind a
    const done: number[] = []
    a!.onDone = (r) => done.push(r.doneAt!)
    b!.onDone = (r) => done.push(r.doneAt!)
    sim.run()
    expect(done.sort((x, y) => x - y)).toEqual([5, 10])
  })
})
