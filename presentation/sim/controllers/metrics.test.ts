import { describe, expect, test } from 'vitest'
import { Cluster } from '../cluster'
import { Sim } from '../engine'
import { LoadBalancer } from '../lb'
import { PodMetrics } from './metrics'

function setup(sim: Sim, n = 2) {
  const lb = new LoadBalancer(sim)
  const cluster = new Cluster(sim, lb, { bootTime: 0, serviceTime: () => 100, concurrency: 4, queueLimit: 0, hungCpu: 1 })
  cluster.scaleTo(n)
  return { lb, cluster }
}

describe('PodMetrics', () => {
  test('samples each instance every interval; value() averages the trailing window', () => {
    const sim = new Sim()
    const { cluster } = setup(sim)
    const [a] = cluster.instances
    const m = new PodMetrics(sim, cluster, { sampleInterval: 5 })
    a.handle({ id: 0, arrivedAt: 0 })         // a at 25%
    m.start()
    sim.run(10)                               // samples at 0, 5, 10
    expect(m.value(a, 15)).toBeCloseTo(0.25)
    expect(m.value(cluster.instances[1], 15)).toBe(0)
  })

  test('no samples yet → undefined', () => {
    const sim = new Sim()
    const { cluster } = setup(sim)
    const m = new PodMetrics(sim, cluster, { sampleInterval: 5 })
    expect(m.value(cluster.instances[0], 15)).toBeUndefined()
  })

  test('samples reported cpu, so hung instances lie', () => {
    const sim = new Sim()
    const { cluster } = setup(sim)
    const [a] = cluster.instances
    const m = new PodMetrics(sim, cluster, { sampleInterval: 5 })
    a.hang(100)
    m.start()
    sim.run(10)
    expect(m.value(a, 15)).toBe(1)
  })

  test('instances launched later get sampled too', () => {
    const sim = new Sim()
    const { cluster } = setup(sim, 1)
    const m = new PodMetrics(sim, cluster, { sampleInterval: 5 })
    m.start()
    sim.run(10)
    cluster.scaleTo(2)
    sim.run(20)
    expect(m.value(cluster.instances[1], 15)).toBe(0)
  })

  test('value(inst, window, at) reads as of an earlier time (metric delay)', () => {
    const sim = new Sim()
    const { cluster } = setup(sim)
    const [a] = cluster.instances
    const m = new PodMetrics(sim, cluster, { sampleInterval: 5 })
    m.start()
    sim.run(20)
    a.handle({ id: 0, arrivedAt: 20 })
    sim.run(40)
    expect(m.value(a, 15, 20)).toBe(0)
    expect(m.value(a, 15, 40)).toBeCloseTo(0.25)
  })
})
