import { describe, expect, test } from 'vitest'
import { Cluster } from '../cluster'
import { Sim } from '../engine'
import type { Instance } from '../instance'
import { LoadBalancer } from '../lb'
import { AwsSimpleScaling, AwsStepScaling, AwsTargetTracking, parseSteps } from './aws'
import { PodMetrics } from './metrics'

function setup(sim: Sim, ready: number, boot = 1000) {
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
  sim.run(400)                     // past warmup for the initial instances
  metrics.start()
  return { cluster, metrics, cpu, setAll }
}
const settle = (sim: Sim, s: number) => sim.run(sim.now + s)

describe('AwsTargetTracking', () => {
  test('scales out after 3 consecutive 1-minute datapoints above target', () => {
    const sim = new Sim()
    const { cluster, metrics, setAll } = setup(sim, 4)
    const tt = new AwsTargetTracking(sim, cluster, metrics, { target: 0.5, min: 1, max: 100 })
    tt.start()
    setAll(0.75)
    settle(sim, 150)
    expect(cluster.size).toBe(4)                      // only 2 full datapoints so far
    settle(sim, 60)
    expect(cluster.size).toBe(6)                      // ceil(4 × 1.5)
  })

  test('warming instances: excluded from metric, counted toward desired → no over-scaling', () => {
    const sim = new Sim()
    const { cluster, metrics, setAll } = setup(sim, 4)
    const tt = new AwsTargetTracking(sim, cluster, metrics, { target: 0.5, min: 1, max: 100, warmup: 300 })
    tt.start()
    setAll(1.0)                                        // 4 warmed at 100% → needs 8
    settle(sim, 240)
    expect(cluster.size).toBe(8)
    settle(sim, 240)                                   // still 100% on the 4 warmed; 4 booting → needs 8 → hold
    expect(cluster.size).toBe(8)
  })

  test('scale-in needs 15 datapoints below 90% of target, and no instance warming up', () => {
    const sim = new Sim()
    const { cluster, metrics, setAll } = setup(sim, 8, 0)
    const tt = new AwsTargetTracking(sim, cluster, metrics, { target: 0.5, min: 1, max: 100, warmup: 300 })
    tt.start()
    setAll(0.2)
    settle(sim, 14 * 60 + 30)
    expect(cluster.size).toBe(8)
    settle(sim, 30)
    expect(cluster.size).toBe(4)                      // ceil(8 × 0.4)
  })

  test('scale-in blocked while instances warm up', () => {
    const sim = new Sim()
    const { cluster, metrics, setAll } = setup(sim, 8, 0)
    const tt = new AwsTargetTracking(sim, cluster, metrics, { target: 0.5, min: 1, max: 100, warmup: 300 })
    tt.start()
    setAll(0.2)
    settle(sim, 14 * 60)
    cluster.scaleTo(9)                                 // something launched (e.g. replacement)
    settle(sim, 4 * 60)
    expect(cluster.size).toBe(9)                      // low alarm firing, but warming blocks scale-in
    settle(sim, 3 * 60)
    expect(cluster.size).toBeLessThan(9)
  })

  test('metric between 90% and 100% of target: no action either way', () => {
    const sim = new Sim()
    const { cluster, metrics, setAll } = setup(sim, 8, 0)
    const tt = new AwsTargetTracking(sim, cluster, metrics, { target: 0.5, min: 1, max: 100 })
    tt.start()
    setAll(0.47)
    settle(sim, 20 * 60)
    expect(cluster.size).toBe(8)
  })

  test('disableScaleIn', () => {
    const sim = new Sim()
    const { cluster, metrics, setAll } = setup(sim, 8, 0)
    new AwsTargetTracking(sim, cluster, metrics, { target: 0.5, min: 1, max: 100, disableScaleIn: true }).start()
    setAll(0.1)
    settle(sim, 20 * 60)
    expect(cluster.size).toBe(8)
  })

  test('metricDelay shifts when datapoints become visible', () => {
    const sim = new Sim()
    const { cluster, metrics, setAll } = setup(sim, 4)
    new AwsTargetTracking(sim, cluster, metrics, { target: 0.5, min: 1, max: 100, metricDelay: 120 }).start()
    setAll(0.75)
    settle(sim, 240)
    expect(cluster.size).toBe(4)
    settle(sim, 120)
    expect(cluster.size).toBe(6)
  })
})

describe('parseSteps', () => {
  test('parses "lower-upper:adjust" list, open upper bound, percent or absolute', () => {
    expect(parseSteps('0-10:+1, 10-20:+10%, 20-:+30%')).toEqual([
      { lower: 0, upper: 10, adjust: 1, percent: false },
      { lower: 10, upper: 20, adjust: 10, percent: true },
      { lower: 20, upper: Infinity, adjust: 30, percent: true },
    ])
    expect(parseSteps('0-10:-1, 10-:-30%')).toEqual([
      { lower: 0, upper: 10, adjust: -1, percent: false },
      { lower: 10, upper: Infinity, adjust: -30, percent: true },
    ])
  })
})

describe('AwsStepScaling', () => {
  const opts = {
    min: 1, max: 100, warmup: 300,
    outThreshold: 0.5, outSteps: '0-0.1:0, 0.1-0.2:+10%, 0.2-:+30%', outEvalPeriods: 1,
    inThreshold: 0.5, inSteps: '0-0.1:0, 0.1-0.2:-10%, 0.2-:-30%', inEvalPeriods: 1,
  }

  test('picks the step by breach size; percent adjustments round toward zero, min 1', () => {
    const sim = new Sim()
    const { cluster, metrics, setAll } = setup(sim, 10)
    new AwsStepScaling(sim, cluster, metrics, opts).start()
    setAll(0.65)                                       // breach 0.15 → +10% of 10 = 1
    settle(sim, 60)
    expect(cluster.size).toBe(11)
  })

  test('while warming: recomputes from warmed capacity, only adds the difference', () => {
    const sim = new Sim()
    const { cluster, metrics, setAll } = setup(sim, 10)
    new AwsStepScaling(sim, cluster, metrics, opts).start()
    setAll(0.65)
    settle(sim, 60)
    expect(cluster.size).toBe(11)
    setAll(0.75)                                       // breach 0.25 → +30% of 10 warmed = 3 → desired 13, already 11 → +2
    settle(sim, 60)
    expect(cluster.size).toBe(13)
    settle(sim, 60)                                    // same step again → 13 already → hold
    expect(cluster.size).toBe(13)
  })

  test('scale-in step, blocked while warming', () => {
    const sim = new Sim()
    const { cluster, metrics, setAll } = setup(sim, 14, 0)
    new AwsStepScaling(sim, cluster, metrics, opts).start()
    setAll(0.35)                                       // breach 0.15 below → −10% of 14 = 1.4 → −1
    settle(sim, 60)
    expect(cluster.size).toBe(13)
  })
})

describe('AwsSimpleScaling', () => {
  test('one adjustment per alarm breach, then cooldown', () => {
    const sim = new Sim()
    const { cluster, metrics, setAll } = setup(sim, 4)
    new AwsSimpleScaling(sim, cluster, metrics, {
      min: 1, max: 100, cooldown: 300,
      outThreshold: 0.7, outAdjust: '+2', outEvalPeriods: 1,
      inThreshold: 0.3, inAdjust: '-1', inEvalPeriods: 1,
    }).start()
    setAll(0.9)
    settle(sim, 60)
    expect(cluster.size).toBe(6)
    settle(sim, 240)                                   // alarm still firing, cooldown 300 s
    expect(cluster.size).toBe(6)
    settle(sim, 120)
    expect(cluster.size).toBe(8)
  })

  test('percent adjustment', () => {
    const sim = new Sim()
    const { cluster, metrics, setAll } = setup(sim, 10)
    new AwsSimpleScaling(sim, cluster, metrics, {
      min: 1, max: 100, cooldown: 300,
      outThreshold: 0.7, outAdjust: '+50%', outEvalPeriods: 1,
      inThreshold: 0.3, inAdjust: '-10%', inEvalPeriods: 1,
    }).start()
    setAll(0.9)
    settle(sim, 60)
    expect(cluster.size).toBe(15)
  })
})
