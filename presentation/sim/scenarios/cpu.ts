import { Arrivals, constant } from '../arrivals'
import { Cluster } from '../cluster'
import { Sim } from '../engine'
import { LoadBalancer } from '../lb'
import { Recorder } from '../metrics'
import { Rng } from '../rng'
import { Autoscaler, targetTracking } from '../scaler'
import { Stats } from '../stats'

export interface CpuScenarioParams {
  /** Mean incoming request rate. */
  rps: number
  /** Mean service time per request. */
  latencyMs: number
  /** Simulated seconds. */
  horizon?: number
  /** Recorder sample period, seconds. */
  sample?: number
  seed?: number
  // --- the knobs nobody tunes ---
  bootSec?: number
  periodSec?: number
  windowSec?: number
  targetCpu?: number
  concurrency?: number
  min?: number
  max?: number
}

export interface CpuScenarioResult {
  t: number[]
  instances: number[]
  ready: number[]
  cpu: number[]
  p99Ms: number[]
  rejected: number[]
}

/** Constant load, one cluster, HPA-style target tracking on "CPU" (busy fraction). */
export function runCpuScenario(p: CpuScenarioParams): CpuScenarioResult {
  const {
    rps, latencyMs, horizon = 1800, sample = 5, seed = 1,
    bootSec = 120, periodSec = 30, windowSec = 60, targetCpu = 0.5,
    concurrency = 16, min = 1, max = 100,
  } = p

  const sim = new Sim()
  const rng = new Rng(seed)
  const stats = new Stats(sim)
  const lb = new LoadBalancer(sim)
  lb.onDone = (r) => stats.record(r)

  const cluster = new Cluster(sim, lb, {
    bootTime: bootSec,
    serviceTime: () => rng.exp(1000 / latencyMs),
    concurrency,
    queueLimit: 0,
  })
  cluster.scaleTo(min)
  sim.run(bootSec) // start with the minimum already warm

  new Arrivals(sim, rng, constant(rps), (r) => lb.handle(r)).start()

  new Autoscaler(sim, cluster, () => cluster.utilization, {
    period: periodSec, sampleInterval: 5, window: windowSec, min, max,
    policy: targetTracking({ target: targetCpu, tolerance: 0.1 }),
  }).start()

  const rec = new Recorder(sim, sample, {
    instances: () => cluster.size,
    ready: () => cluster.ready,
    cpu: () => cluster.utilization,
    p99Ms: () => {
      const v = stats.latency(sample).percentile(0.99)
      return Number.isNaN(v) ? 0 : v * 1000
    },
    rejected: () => stats.totals.rejected,
  })
  rec.start()
  sim.run(bootSec + horizon)

  return {
    t: rec.t.map((t) => t - bootSec),
    instances: rec.series.instances,
    ready: rec.series.ready,
    cpu: rec.series.cpu,
    p99Ms: rec.series.p99Ms,
    rejected: rec.series.rejected,
  }
}
