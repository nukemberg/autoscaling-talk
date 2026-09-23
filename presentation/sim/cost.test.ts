import { describe, expect, test } from 'vitest'
import { Sim } from './engine'
import { Cluster } from './cluster'
import { Cost } from './cost'
import { LoadBalancer } from './lb'
import { flatOpts } from './test-helpers'

function setup(sim: Sim) {
  const lb = new LoadBalancer(sim)
  const cluster = new Cluster(sim, lb, flatOpts({ bootTime: 0, serviceTime: () => 1, concurrency: 1, queueLimit: 0 }))
  return { lb, cluster }
}

describe('Cluster.instanceTime', () => {
  test('integrates size over time (booting instances count — you pay for them)', () => {
    const sim = new Sim()
    const { cluster } = setup(sim)
    cluster.scaleTo(2)
    sim.run(5)          // 2 * 5
    cluster.scaleTo(1)
    sim.run(10)         // 1 * 5
    expect(cluster.instanceTime).toBe(15)
  })
})

describe('Cost', () => {
  test('total = instancePrice * instanceTime', () => {
    const sim = new Sim()
    const { cluster } = setup(sim)
    const cost = new Cost(sim, { cluster, instancePrice: 2 })
    cluster.scaleTo(3)
    sim.run(4)
    expect(cost.total).toBe(24)
  })

  test('extraRate is integrated over time (e.g. upstream tier cost as a function of load)', () => {
    const sim = new Sim()
    const { cluster } = setup(sim)
    const cost = new Cost(sim, { cluster, instancePrice: 0, extraRate: () => cluster.size, sampleInterval: 1 })
    cost.start()
    cluster.scaleTo(2)
    sim.run(5)          // 2/unit * 5
    expect(cost.total).toBeCloseTo(10)
  })
})
