import { describe, expect, test } from 'vitest'
import { Cluster } from '../cluster'
import { Sim } from '../engine'
import { LoadBalancer } from '../lb'
import { PodMetrics } from './metrics'
import { flatOpts } from '../test-helpers'

function setup(sim: Sim, n = 2, o: { concurrency?: number; serviceTime?: number } = {}) {
  const lb = new LoadBalancer(sim)
  const cluster = new Cluster(sim, lb, flatOpts({
    bootTime: 0, serviceTime: () => o.serviceTime ?? 100, concurrency: o.concurrency ?? 4, queueLimit: 0, hungCpu: 1,
  }))
  cluster.scaleTo(n)
  return { lb, cluster }
}

describe('PodMetrics (default: cumulative cpu counter, rate over the window)', () => {
  test('samples each instance every interval; value() is the busy rate over the trailing window', () => {
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

  test('a single core that is only ever 0% or 100% busy reads as its true time-average, not what the scrape instants happened to see', () => {
    // One core, busy 2.5 s out of every 5 s, phased so every scrape instant lands mid-burst.
    const run = (kind: 'counter' | 'gauge') => {
      const sim = new Sim()
      const { cluster } = setup(sim, 1, { concurrency: 1, serviceTime: 2.5 })
      const [a] = cluster.instances
      for (let t = 4; t < 30; t += 5) sim.schedule(t, () => a.handle({ id: t, arrivedAt: t }))
      const m = new PodMetrics(sim, cluster, {
        sampleInterval: 5,
        ...(kind === 'gauge' ? { source: { kind, read: (i) => i.cpu } } : {}),
      })
      m.start()
      sim.run(30)
      return m.value(a, 15)
    }
    expect(run('counter')).toBeCloseTo(0.5) // busy [15,16.5) + [19,21.5) + [24,26.5) + [29,30] = 7.5 s of 15
    expect(run('gauge')).toBe(1)            // every point sample saw the core busy: biased high
  })

  test('no samples yet → undefined; one sample is not enough for a rate → undefined', () => {
    const sim = new Sim()
    const { cluster } = setup(sim)
    const m = new PodMetrics(sim, cluster, { sampleInterval: 5 })
    expect(m.value(cluster.instances[0], 15)).toBeUndefined()
    m.start()                                 // first scrape, at t=0
    expect(m.value(cluster.instances[0], 15)).toBeUndefined()
    sim.run(5)
    expect(m.value(cluster.instances[0], 15)).toBe(0)
  })

  test('window with no samples in it → undefined, even with older history', () => {
    const sim = new Sim()
    const { cluster } = setup(sim)
    const m = new PodMetrics(sim, cluster, { sampleInterval: 5 })
    m.start()
    sim.run(20)
    expect(m.value(cluster.instances[0], 3, 23)).toBeUndefined()
  })

  test('samples reported cpu, so hung instances lie — and stop lying once the hang ends', () => {
    const sim = new Sim()
    const { cluster } = setup(sim)
    const [a] = cluster.instances
    const m = new PodMetrics(sim, cluster, { sampleInterval: 5 })
    a.handle({ id: 0, arrivedAt: 0 })         // honest cpu: 25%
    a.hang(10)                                // reports 100% (hungCpu: 1) until t=10
    m.start()
    sim.run(30)
    expect(m.value(a, 10, 10)).toBe(1)
    expect(m.value(a, 10, 30)).toBeCloseTo(0.25)
    expect(m.value(a, 20, 20)).toBeCloseTo((10 * 1 + 10 * 0.25) / 20) // straddles the hang's end
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

describe('PodMetrics.latest — the single freshest reading, no caller-chosen window', () => {
  test('counter: rate between the two most recent scrapes only, not the whole history', () => {
    const sim = new Sim()
    const { cluster } = setup(sim, 1, { concurrency: 1, serviceTime: 2.5 })
    const [a] = cluster.instances
    const m = new PodMetrics(sim, cluster, { sampleInterval: 5 })
    m.start()
    sim.run(5)                                // idle so far: rate over [0,5] is 0
    a.handle({ id: 0, arrivedAt: 5 })         // busy for the next 2.5 s
    sim.run(10)                               // scrape at 10 sees the busy stretch; rate over [5,10] is 0.5
    expect(m.latest(a)).toBeCloseTo(0.5)      // not blended with the earlier idle interval
  })

  test('counter: fewer than two samples → undefined', () => {
    const sim = new Sim()
    const { cluster } = setup(sim)
    const m = new PodMetrics(sim, cluster, { sampleInterval: 5 })
    expect(m.latest(cluster.instances[0])).toBeUndefined()
    m.start()
    expect(m.latest(cluster.instances[0])).toBeUndefined() // one scrape, no delta yet
    sim.run(5)
    expect(m.latest(cluster.instances[0])).toBe(0)
  })

  test('gauge: the single most recent sample, not averaged with older ones', () => {
    const sim = new Sim()
    const { cluster } = setup(sim, 1)
    const [a] = cluster.instances
    let level = 0.2
    const m = new PodMetrics(sim, cluster, { sampleInterval: 5, source: { kind: 'gauge', read: () => level } })
    m.start()                                 // 0.2 at t=0
    sim.schedule(7, () => { level = 0.8 })
    sim.run(10)                               // 0.2 at 5, 0.8 at 10
    expect(m.latest(a)).toBe(0.8)             // value() over the same window would blend to 0.4
  })

  test('reads as of an earlier time (metric delay), same as value()', () => {
    const sim = new Sim()
    const { cluster } = setup(sim)
    const [a] = cluster.instances
    const m = new PodMetrics(sim, cluster, { sampleInterval: 5 })
    m.start()
    sim.run(20)
    a.handle({ id: 0, arrivedAt: 20 })
    sim.run(40)
    expect(m.latest(a, 20)).toBe(0)
    expect(m.latest(a, 40)).toBeCloseTo(0.25)
  })
})

describe('PodMetrics with a gauge source', () => {
  test('value() is the mean of the point samples in the window', () => {
    const sim = new Sim()
    const { cluster } = setup(sim, 1)
    const [a] = cluster.instances
    let level = 0.2
    const m = new PodMetrics(sim, cluster, { sampleInterval: 5, source: { kind: 'gauge', read: () => level } })
    m.start()                                 // 0.2 at t=0
    sim.schedule(7, () => { level = 0.8 })
    sim.run(10)                               // 0.2 at 5, 0.8 at 10
    expect(m.value(a, 15)).toBeCloseTo(0.4)
    expect(m.value(a, 3)).toBeCloseTo(0.8)    // one sample is enough for a gauge
  })

  test('a scrape where read() returns undefined records no sample (d8q)', () => {
    const sim = new Sim()
    const { cluster } = setup(sim, 1)
    const [a] = cluster.instances
    let level: number | undefined = 0.5
    const m = new PodMetrics(sim, cluster, { sampleInterval: 5, source: { kind: 'gauge', read: () => level } })
    m.start()                                 // 0.5 at t=0
    sim.schedule(5, () => { level = undefined })
    sim.run(10)                               // no sample recorded at t=5 or t=10
    expect(m.latest(a)).toBe(0.5)             // still the last real sample, not undefined-as-0
    expect(m.value(a, 3)).toBeUndefined()     // nothing in the last 3s
  })
})
