import { Arrivals, logistic, ramp as linear, step, type Rate } from '../arrivals'
import { Cluster } from '../cluster'
import { Sim } from '../engine'
import { LoadBalancer } from '../lb'
import { Recorder } from '../metrics'
import { Rng } from '../rng'
import { Autoscaler, targetTracking } from '../scaler'
import { Stats } from '../stats'

export interface CpuScenarioParams {
  /** Incoming request rate after the ramp. */
  rps: number
  /** Stable load during the quiet period; the ramp starts here. Default 0. */
  baseRps?: number
  /** Mean service time per request. */
  latencyMs: number
  /** Load ramp shape from 0 to `rps`, starting at t=0. */
  ramp?: 'step' | 'linear' | 'logistic'
  /** Ramp duration, seconds (ignored for step). */
  rampSec?: number
  /** Idle time before load starts, seconds. Shows the "before" state. */
  quietSec?: number
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
  /** Arrival rate the load profile asked for. */
  offeredRps: number[]
  /** Successful completions per second over the last sample window. */
  okRps: number[]
  /** Failed (rejected/error/timeout) per second over the last sample window. */
  failedRps: number[]
}

function loadProfile(shape: 'step' | 'linear' | 'logistic', from: number, to: number, rampSec: number): Rate {
  switch (shape) {
    case 'step': return step(0, from, to)
    case 'linear': return linear(0, rampSec, from, to)
    case 'logistic': return logistic(0, rampSec, from, to)
  }
}

/** Constant load, one cluster, HPA-style target tracking on "CPU" (busy fraction). */
export function runCpuScenario(p: CpuScenarioParams): CpuScenarioResult {
  const {
    rps, baseRps = 0, latencyMs, ramp = 'step', rampSec = 300, quietSec = 300, horizon = 2100, sample = 5, seed = 1,
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
  // Start already sized for the base load, warm — the steady state before anything happens.
  const needed = Math.ceil(baseRps * latencyMs / 1000 / concurrency / targetCpu)
  cluster.scaleTo(Math.min(max, Math.max(min, needed)))
  sim.run(bootSec)

  const load = loadProfile(ramp, baseRps, rps, rampSec)
  const t0 = sim.now + quietSec
  const offered: Rate = Object.assign((t: number) => (t < t0 ? baseRps : load(t - t0)), { max: load.max })
  new Arrivals(sim, rng, offered, (r) => lb.handle(r)).start()

  let lastTotals = { ...stats.totals }
  const perSecond = (pick: (d: Record<string, number>) => number) => () => {
    const d: Record<string, number> = {}
    for (const k of Object.keys(stats.totals) as (keyof typeof stats.totals)[]) d[k] = stats.totals[k] - lastTotals[k]
    return pick(d) / sample
  }

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
    offeredRps: () => offered(sim.now),
    okRps: perSecond((d) => d.ok),
    failedRps: perSecond((d) => d.rejected + d.error + d.timeout),
    // Probes run in order; this last one resets the per-window baseline.
    _tick: () => { lastTotals = { ...stats.totals }; return 0 },
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
    offeredRps: rec.series.offeredRps,
    okRps: rec.series.okRps,
    failedRps: rec.series.failedRps,
  }
}
