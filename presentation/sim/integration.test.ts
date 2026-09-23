import { describe, expect, test } from 'vitest'
import { Arrivals, constant, step } from './arrivals'
import { Cluster } from './cluster'
import { Sim } from './engine'
import { Instance } from './instance'
import { LoadBalancer } from './lb'
import { Recorder } from './metrics'
import { Rng } from './rng'
import { Autoscaler, threshold } from './scaler'
import { Stats } from './stats'
import { flatOpts } from './test-helpers'

describe('queueing sanity', () => {
  test('M/M/1 with ρ=0.5: mean sojourn ≈ 1/(μ-λ) = 2', () => {
    const sim = new Sim()
    const rng = new Rng(1)
    const stats = new Stats(sim)
    const inst = new Instance(sim, flatOpts({ bootTime: 0, serviceTime: () => rng.exp(1), concurrency: 1, queueLimit: Infinity }))
    inst.onDone = (r) => stats.record(r)
    new Arrivals(sim, rng, constant(0.5), (r) => inst.handle(r)).start()
    sim.run(200_000)
    const w = stats.latency(200_000).mean
    expect(w).toBeGreaterThan(1.9)
    expect(w).toBeLessThan(2.1)
  })

  test('M/M/2 with λ=1.5, μ=1: mean sojourn ≈ 2.286 (Erlang C)', () => {
    const sim = new Sim()
    const rng = new Rng(2)
    const stats = new Stats(sim)
    const inst = new Instance(sim, flatOpts({ bootTime: 0, serviceTime: () => rng.exp(1), concurrency: 2, queueLimit: Infinity }))
    inst.onDone = (r) => stats.record(r)
    new Arrivals(sim, rng, constant(1.5), (r) => inst.handle(r)).start()
    sim.run(200_000)
    const w = stats.latency(200_000).mean
    expect(w).toBeGreaterThan(2.286 * 0.95)
    expect(w).toBeLessThan(2.286 * 1.05)
  })
})

function oscillationScenario(seed: number) {
  const sim = new Sim()
  const rng = new Rng(seed)
  const stats = new Stats(sim)
  const lb = new LoadBalancer(sim)
  lb.onDone = (r) => stats.record(r)
  const cluster = new Cluster(sim, lb, flatOpts({
    bootTime: 120, serviceTime: () => rng.exp(10), concurrency: 8, queueLimit: 0,
  }))
  cluster.scaleTo(2)
  new Arrivals(sim, rng, step(300, 40, 120), (r) => lb.handle(r)).start()
  const scaler = new Autoscaler(sim, cluster, () => cluster.utilization, {
    period: 30, window: 60, sampleInterval: 5, min: 1, max: 50,
    policy: threshold({ up: 0.7, down: 0.3, step: 2 }),
  })
  scaler.start()
  const rec = new Recorder(sim, 10, {
    size: () => cluster.size,
    ready: () => cluster.ready,
    cpu: () => cluster.utilization,
    rejected: () => stats.totals.rejected,
  })
  rec.start()
  sim.run(3000)
  return { cluster, stats, rec }
}

describe('end to end', () => {
  test('CPU threshold scaler with long boot delay overshoots and reverses (smoke test)', () => {
    const { cluster, rec } = oscillationScenario(7)
    expect(cluster.launched + cluster.terminated).toBeGreaterThan(10)
    const sizes = rec.series.size
    expect(Math.max(...sizes)).toBeGreaterThanOrEqual(3 * sizes[sizes.length - 1])
    let reversals = 0, dir = 0
    for (let i = 1; i < sizes.length; i++) {
      const d = Math.sign(sizes[i] - sizes[i - 1])
      if (d && dir && d !== dir) reversals++
      if (d) dir = d
    }
    expect(reversals).toBeGreaterThanOrEqual(2)
  })

  test('same seed → identical series; different seed → different', () => {
    const a = oscillationScenario(7), b = oscillationScenario(7), c = oscillationScenario(8)
    expect(a.rec.toUPlot()).toEqual(b.rec.toUPlot())
    expect(a.rec.toUPlot()).not.toEqual(c.rec.toUPlot())
  })

  test('runs fast enough for on-stage use (3000s sim, ~300k requests < 1s)', () => {
    const t0 = performance.now()
    const { stats } = oscillationScenario(9)
    const ms = performance.now() - t0
    const n = Object.values(stats.totals).reduce((a, b) => a + b, 0)
    expect(n).toBeGreaterThan(200_000)
    expect(ms).toBeLessThan(1000)
  })
})
