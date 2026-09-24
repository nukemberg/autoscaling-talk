import { describe, expect, test } from 'vitest'
import { Cluster } from '../cluster'
import { Sim } from '../engine'
import { LoadBalancer } from '../lb'
import { Stats } from '../stats'
import { flatOpts } from '../test-helpers'
import { latencyMetric, metricRegistry } from './metricRegistry'

function setup(sim: Sim) {
  const lb = new LoadBalancer(sim)
  const cluster = new Cluster(sim, lb, flatOpts({ bootTime: 0, serviceTime: () => 1, concurrency: 4, queueLimit: 0 }))
  cluster.scaleTo(1)
  return cluster.instances[0]!
}

describe('metricRegistry', () => {
  test('cpu reads inst.cpuSeconds as a counter', () => {
    expect(metricRegistry.cpu.source.kind).toBe('counter')
    const sim = new Sim()
    const inst = setup(sim)
    expect(metricRegistry.cpu.source.read(inst)).toBe(inst.cpuSeconds)
  })

  test('worker reads inst.utilization as a gauge', () => {
    expect(metricRegistry.worker.source.kind).toBe('gauge')
    const sim = new Sim()
    const inst = setup(sim)
    inst.handle({ id: 0, arrivedAt: 0 })
    expect(metricRegistry.worker.source.read(inst)).toBe(inst.utilization)
  })

  test('queue reads inst.queued as a gauge', () => {
    expect(metricRegistry.queue.source.kind).toBe('gauge')
    const sim = new Sim()
    const inst = setup(sim)
    expect(metricRegistry.queue.source.read(inst)).toBe(inst.queued)
  })

  test('rps reads inst.servedRequests as a counter', () => {
    expect(metricRegistry.rps.source.kind).toBe('counter')
    const sim = new Sim()
    const inst = setup(sim)
    expect(metricRegistry.rps.source.read(inst)).toBe(inst.servedRequests)
  })

  test('every registry entry has a positive defaultTarget and a kind', () => {
    for (const def of Object.values(metricRegistry)) {
      expect(def.defaultTarget).toBeGreaterThan(0)
      expect(['utilization', 'absolute']).toContain(def.kind)
    }
  })
})

describe('latencyMetric', () => {
  test('reports the same cluster-wide value regardless of which instance is asked', () => {
    const sim = new Sim()
    const stats = new Stats(sim)
    stats.record({ id: 0, arrivedAt: 0, doneAt: 0.25, outcome: 'ok' }) // 250ms
    const a = setup(sim)
    const b = setup(new Sim()) // a different Instance entirely
    const m = latencyMetric(stats, 60)
    expect(m.source.kind).toBe('gauge')
    const va = m.source.read(a)
    const vb = m.source.read(b)
    expect(va).toBe(vb) // the whole point: degenerate per-pod, same value everywhere
    expect(va).toBeCloseTo(250, 0)
  })

  test('reports 0 when there is no recent data, not NaN', () => {
    const sim = new Sim()
    const stats = new Stats(sim)
    const inst = setup(sim)
    expect(latencyMetric(stats, 60).source.read(inst)).toBe(0)
  })
})
