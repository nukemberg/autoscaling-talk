import { describe, expect, test } from 'vitest'
import { Sim } from './engine'
import { Cluster } from './cluster'
import { LoadBalancer } from './lb'

function setup(sim: Sim, boot = 5) {
  const lb = new LoadBalancer(sim)
  const cluster = new Cluster(sim, lb, { bootTime: boot, serviceTime: () => 1, concurrency: 1, queueLimit: 0 })
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
