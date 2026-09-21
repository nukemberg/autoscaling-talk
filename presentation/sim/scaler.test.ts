import { describe, expect, test } from 'vitest'
import { Sim } from './engine'
import { Autoscaler, targetTracking, threshold, type ScalerOpts } from './scaler'

/** Fake scalable target: records scaleTo calls. */
function target(initial = 1) {
  const calls: [number, number][] = []
  let size = initial
  return {
    calls,
    get size() { return size },
    scaleTo(n: number) { calls.push([-1, n]); size = n },
  }
}

function setup(sim: Sim, signal: () => number, over: Partial<ScalerOpts> = {}, initial = 1) {
  const tgt = target(initial)
  const scaler = new Autoscaler(sim, tgt, signal, {
    period: 10, min: 1, max: 100, policy: threshold({ up: 0.7, down: 0.3, step: 1 }), ...over,
  })
  scaler.start()
  return { tgt, scaler }
}

describe('policies', () => {
  test('threshold: +step above up, -step below down, else hold', () => {
    const p = threshold({ up: 0.7, down: 0.3, step: 2 })
    expect(p(0.8, 5)).toBe(7)
    expect(p(0.2, 5)).toBe(3)
    expect(p(0.5, 5)).toBe(5)
  })

  test('targetTracking: desired = ceil(current * metric / target), within tolerance holds', () => {
    const p = targetTracking({ target: 0.5, tolerance: 0.1 })
    expect(p(1.0, 4)).toBe(8)
    expect(p(0.25, 4)).toBe(2)
    expect(p(0.52, 4)).toBe(4)   // ratio 1.04 within 10%
    expect(p(0.6, 4)).toBe(5)    // ceil(4 * 1.2) = 5
  })

  test('targetTracking with metric 0 → 0 (min clamp is the scaler’s job)', () => {
    expect(targetTracking({ target: 0.5 })(0, 4)).toBe(0)
  })
})

describe('Autoscaler', () => {
  test('evaluates every period and applies policy', () => {
    const sim = new Sim()
    const { tgt } = setup(sim, () => 0.9)
    sim.run(30)
    expect(tgt.calls.map((c) => c[1])).toEqual([2, 3, 4])
    expect(tgt.size).toBe(4)
  })

  test('clamps to min/max', () => {
    const sim = new Sim()
    const { tgt } = setup(sim, () => 0.9, { max: 2 })
    sim.run(50)
    expect(tgt.size).toBe(2)
    const sim2 = new Sim()
    const t2 = setup(sim2, () => 0.0, { min: 3 }, 5).tgt
    sim2.run(50)
    expect(t2.size).toBe(3)
  })

  test('does not call scaleTo when desired equals current', () => {
    const sim = new Sim()
    const { tgt } = setup(sim, () => 0.5)
    sim.run(50)
    expect(tgt.calls).toEqual([])
  })

  test('scale-up cooldown blocks further scale-ups', () => {
    const sim = new Sim()
    const { tgt } = setup(sim, () => 0.9, { scaleUpCooldown: 25 })
    sim.run(60)
    // t=10 up, t=20/30 blocked, t=40 up, t=50 blocked, t=60 blocked (40+25=65)
    expect(tgt.calls.map((c) => c[1])).toEqual([2, 3])
  })

  test('scale-down cooldown blocks further scale-downs but not scale-ups', () => {
    const sim = new Sim()
    let m = 0.1
    const { tgt } = setup(sim, () => m, { scaleDownCooldown: 25 }, 5)
    sim.run(20)                 // t=10 down→4, t=20 blocked
    expect(tgt.size).toBe(4)
    m = 0.9
    sim.run(30)                 // t=30 up → 5 despite down-cooldown
    expect(tgt.size).toBe(5)
  })

  test('metricDelay: decision at t uses signal value from t - delay', () => {
    const sim = new Sim()
    const { tgt } = setup(sim, () => (sim.now >= 15 ? 0.9 : 0.5), { metricDelay: 10, sampleInterval: 5 })
    sim.run(20)
    expect(tgt.calls).toEqual([])          // at t=20 it sees the value from t=10 (0.5)
    sim.run(30)
    expect(tgt.calls.map((c) => c[1])).toEqual([2])  // at t=30 it sees t=20 (0.9)
  })

  test('window: metric is the average of samples within the window', () => {
    const sim = new Sim()
    const { tgt } = setup(sim, () => (sim.now === 10 ? 1.0 : 0.5), { window: 10, sampleInterval: 5 })
    // samples at 0,5,10 → t=10 decision window (0,10] = 0.5, 1.0 → 0.75 → up
    sim.run(10)
    expect(tgt.size).toBe(2)
    // t=20 window (10,20] = 0.5,0.5 → hold
    sim.run(20)
    expect(tgt.size).toBe(2)
  })

  test('stabilizationWindow: scale-down uses the max desired seen in the window', () => {
    const sim = new Sim()
    let m = 0.9
    const { tgt } = setup(sim, () => m, { stabilizationWindow: 25 }, 5)
    sim.run(10)                 // desired 6
    expect(tgt.size).toBe(6)
    m = 0.1
    sim.run(30)                 // t=20,30 desired 5 but max over window still 6 (from t=10) → hold
    expect(tgt.size).toBe(6)
    sim.run(40)                 // t=40: window (15,40] has 5,5,5 → down
    expect(tgt.size).toBe(5)
  })

  test('exposes last metric and desired for plotting', () => {
    const sim = new Sim()
    const { scaler } = setup(sim, () => 0.9)
    sim.run(10)
    expect(scaler.metric).toBeCloseTo(0.9)
    expect(scaler.desired).toBe(2)
  })
})

describe('Autoscaler countInFlight', () => {
  function readyTarget(ready: number, booting: number) {
    const calls: number[] = []
    let size = ready + booting
    return {
      calls,
      get size() { return size },
      get ready() { return ready },
      scaleTo(n: number) { calls.push(n); size = n },
    }
  }

  test('off (default): policy multiplies total size, so booting instances compound', () => {
    const sim = new Sim()
    const tgt = readyTarget(2, 4)
    new Autoscaler(sim, tgt, () => 1.0, {
      period: 10, min: 1, max: 100, policy: targetTracking({ target: 0.5 }),
    }).start()
    sim.run(10)
    expect(tgt.calls).toEqual([12]) // 6 × 2
  })

  test('on: desired computed from ready capacity, launch only if above what is already ordered', () => {
    const sim = new Sim()
    const tgt = readyTarget(2, 4)
    new Autoscaler(sim, tgt, () => 1.0, {
      period: 10, min: 1, max: 100, policy: targetTracking({ target: 0.5 }), countInFlight: true,
    }).start()
    sim.run(10)
    expect(tgt.calls).toEqual([]) // wants 4 = 2 × 2, already have 6 on order → hold
  })

  test('on: scales up when ready-based desired exceeds total', () => {
    const sim = new Sim()
    const tgt = readyTarget(4, 1)
    new Autoscaler(sim, tgt, () => 1.0, {
      period: 10, min: 1, max: 100, policy: targetTracking({ target: 0.5 }), countInFlight: true,
    }).start()
    sim.run(10)
    expect(tgt.calls).toEqual([8]) // 4 × 2 = 8 > 5
  })

  test('on: scale-down still allowed when ready-based desired is below total', () => {
    const sim = new Sim()
    const tgt = readyTarget(8, 0)
    new Autoscaler(sim, tgt, () => 0.1, {
      period: 10, min: 1, max: 100, policy: targetTracking({ target: 0.5 }), countInFlight: true,
    }).start()
    sim.run(10)
    expect(tgt.calls).toEqual([2]) // ceil(8 × 0.2)
  })
})
