import { describe, expect, test } from 'vitest'
import { Cluster } from '../cluster'
import { Sim } from '../engine'
import type { Instance } from '../instance'
import { LoadBalancer } from '../lb'
import { Hpa, type HpaOpts } from './hpa'
import { PodMetrics } from './metrics'

/**
 * Cluster where the first `ready` launches boot instantly and later ones take
 * `boot` seconds; per-pod cpu is dictated by the test through `cpu`.
 */
function setup(sim: Sim, ready: number, over: Partial<HpaOpts> = {}, boot = 1000) {
  const lb = new LoadBalancer(sim)
  let launches = 0
  const cluster = new Cluster(sim, lb, {
    bootTime: () => (launches++ < ready ? 0 : boot), serviceTime: () => 1, concurrency: 10, queueLimit: 0,
  })
  cluster.scaleTo(ready)
  const cpu = new Map<Instance, number>()
  let all = 0
  const setAll = (v: number) => { all = v; cpu.clear() }
  const metrics = new PodMetrics(sim, cluster, { sampleInterval: 5, read: (i) => cpu.get(i) ?? all })
  sim.run(60)                      // past initialReadinessDelay
  metrics.start()
  const hpa = new Hpa(sim, cluster, metrics, { target: 0.5, min: 1, max: 100, ...over })
  return { cluster, hpa, cpu, setAll }
}

const settle = (sim: Sim, s: number) => sim.run(sim.now + s)

describe('Hpa', () => {
  test('desired = ceil(current × avg/target), evaluated every syncPeriod (15 s)', () => {
    const sim = new Sim()
    const { cluster, hpa, setAll } = setup(sim, 4)
    setAll(0.6)
    settle(sim, 15)
    hpa.start()
    settle(sim, 15)
    expect(cluster.size).toBe(5)                          // ceil(4 × 1.2)
  })

  test('within tolerance (10%) → no action', () => {
    const sim = new Sim()
    const { cluster, hpa, setAll } = setup(sim, 10)
    setAll(0.54)
    settle(sim, 15)
    hpa.start()
    settle(sim, 60)
    expect(cluster.size).toBe(10)
  })

  test('scale-up: not-yet-ready pods count as 0%, so booting pods are not multiplied again', () => {
    const sim = new Sim()
    const { cluster, hpa, setAll } = setup(sim, 2, { scaleUpPods: 100 })
    setAll(1.0)                                            // 2 ready at 100% → wants 4
    settle(sim, 15)
    hpa.start()
    settle(sim, 15)
    expect(cluster.size).toBe(4)
    settle(sim, 60)                                        // still 100% on the 2 ready; 2 booting → ceil(2×2)=4 ≤ 4 → hold
    expect(cluster.size).toBe(4)
  })

  test('scale-up is limited to max(4 pods, 100%) per 15 s', () => {
    const sim = new Sim()
    const { cluster, hpa, setAll } = setup(sim, 1, { target: 0.05 }, 0)
    setAll(1.0)                                            // 100% vs 5% → wants 20
    settle(sim, 15)
    hpa.start()
    settle(sim, 15)
    expect(cluster.size).toBe(5)                          // 1 + 4
    settle(sim, 15)
    expect(cluster.size).toBe(10)                         // 5 + max(4, 100% of 5)
  })

  test('scale-down uses the max recommendation over the stabilization window (300 s)', () => {
    const sim = new Sim()
    const { cluster, hpa, setAll } = setup(sim, 8)
    setAll(0.5)
    settle(sim, 15)
    hpa.start()
    settle(sim, 30)
    expect(cluster.size).toBe(8)
    setAll(0.0)                                            // wants 1, but window still holds 8
    settle(sim, 200)
    expect(cluster.size).toBe(8)
    settle(sim, 130)
    expect(cluster.size).toBe(1)
  })

  test('scale-down: pods with missing metrics are assumed at 100% of target', () => {
    const sim = new Sim()
    const { cluster, hpa, setAll } = setup(sim, 4, { downStabilization: 0 })
    cluster.scaleTo(6)                                     // 2 booting, no metrics
    setAll(0.2)                                            // 4 ready at 20% → 1.6 + 2 booting at target → ceil(3.6) = 4
    settle(sim, 15)
    hpa.start()
    settle(sim, 15)
    expect(cluster.size).toBe(4)
  })

  test('clamps to max', () => {
    const sim = new Sim()
    const { cluster, hpa, setAll } = setup(sim, 2, { max: 3, target: 0.05, scaleUpPods: 100 })
    setAll(1.0)
    settle(sim, 15)
    hpa.start()
    settle(sim, 60)
    expect(cluster.size).toBe(3)
  })

  test('no ready pods with metrics → no action', () => {
    const sim = new Sim()
    const { cluster, hpa } = setup(sim, 0)
    hpa.start()
    settle(sim, 60)
    expect(cluster.size).toBe(0)
  })

  test('exposes metric and desired for plotting', () => {
    const sim = new Sim()
    const { hpa, setAll } = setup(sim, 4)
    setAll(0.6)
    settle(sim, 15)
    hpa.start()
    settle(sim, 15)
    expect(hpa.metric).toBeCloseTo(0.6)
    expect(hpa.desired).toBe(5)
  })
})
