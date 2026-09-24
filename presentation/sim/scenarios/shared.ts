import {
  boxcar, expGrowth, flashCrowd, gaussian, logistic, noisy, ramp as linear, sawtooth, sine, squareWave, step,
  trapezoid, type Rate,
} from '../arrivals'
import type { Sim } from '../engine'
import type { Cluster, ClusterOpts } from '../cluster'
import type { Fault } from '../faults'
import type { InstanceOpts, Step } from '../instance'
import type { LbOpts } from '../lb'
import { AwsSimpleScaling, AwsStepScaling, AwsTargetTracking } from '../controllers/aws'
import { Hpa } from '../controllers/hpa'
import { PodMetrics } from '../controllers/metrics'
import type { Rng } from '../rng'
import type { Stats } from '../stats'
import { distParams, sampleDist } from './dist'
import { latencyMetric, metricRegistry } from './metricRegistry'
import { bool, num, str, type ParamSpec, type Params } from './types'

// ---------------- load ----------------

export const loadParams: ParamSpec[] = [
  { key: 'baseRps', label: 'base load', group: 'load', kind: 'range', min: 0, max: 2000, step: 10, default: 100, unit: 'rps',
    help: 'Steady request rate before the ramp. The cluster starts sized for this.' },
  { key: 'rps', label: 'load after ramp', group: 'load', kind: 'range', min: 10, max: 4000, step: 10, default: 400, unit: 'rps',
    help: 'Request rate the ramp ends at, held until the end of the run.' },
  { key: 'ramp', label: 'ramp', group: 'load', kind: 'select', default: 'step', options: [
    { value: 'step', label: 'heaviside (step)' }, { value: 'linear', label: 'linear' }, { value: 'logistic', label: 'logistic' },
    { value: 'pulse-box', label: 'pulse (box)' }, { value: 'pulse-gaussian', label: 'pulse (gaussian)' },
    { value: 'trapezoid', label: 'trapezoid' }, { value: 'exp-growth', label: 'exponential growth' },
    { value: 'flash-crowd', label: 'flash crowd' }, { value: 'sine', label: 'sine wave' },
    { value: 'sawtooth', label: 'sawtooth' }, { value: 'square', label: 'square wave' },
  ], help: 'Shape of the transition from base load to final load.' },
  { key: 'rampSec', label: 'ramp time', group: 'load', kind: 'range', min: 10, max: 1800, step: 10, default: 300, unit: 's',
    help: 'Rise time: ramp duration, pulse/gaussian width, trapezoid rise, or exp-growth/flash-crowd time constant.',
    activeWhen: { ramp: ['linear', 'logistic', 'pulse-box', 'pulse-gaussian', 'trapezoid', 'exp-growth', 'flash-crowd'] } },
  { key: 'periodSec', label: 'period', group: 'load', kind: 'range', min: 10, max: 1800, step: 10, default: 200, unit: 's',
    help: 'Period of the repeating waveform.', activeWhen: { ramp: ['sine', 'sawtooth', 'square'] } },
  { key: 'holdSec', label: 'hold time', group: 'load', kind: 'range', min: 0, max: 1800, step: 10, default: 200, unit: 's',
    help: 'Trapezoid: time held at peak. Square wave: fraction of the period held high, ×1800s.',
    activeWhen: { ramp: ['trapezoid', 'square'] } },
  { key: 'quietSec', label: 'stable period before ramp', group: 'load', kind: 'range', min: 0, max: 900, step: 30, default: 300, unit: 's',
    help: 'Time at base load before the ramp starts, so the "before" state is visible.' },
  { key: 'noisyLoad', label: 'noisy base', group: 'load', kind: 'toggle', default: false,
    help: 'Adds bounded random jitter on top of whichever shape is chosen, so "steady" load is never perfectly flat.' },
  { key: 'noiseAmpPct', label: 'noise amplitude', group: 'load', kind: 'range', min: 1, max: 50, step: 1, default: 10, unit: '%',
    help: 'Jitter as a fraction of the instantaneous rate.', activeWhen: { noisyLoad: 'true' } },
]

/** Rate profile: baseRps until t0, then ramp to rps. Absolute time. */
export function loadProfile(p: Params, t0: number, rng: Rng): Rate {
  const from = num(p, 'baseRps'), to = num(p, 'rps'), dur = num(p, 'rampSec')
  const period = num(p, 'periodSec'), hold = num(p, 'holdSec')
  let shape: Rate
  switch (str(p, 'ramp')) {
    case 'linear': shape = linear(0, dur, from, to); break
    case 'logistic': shape = logistic(0, dur, from, to); break
    case 'pulse-box': shape = boxcar(0, dur, from, to); break
    case 'pulse-gaussian': shape = gaussian(dur, dur / 3, from, to); break
    case 'trapezoid': shape = trapezoid(0, dur, hold, from, to); break
    case 'exp-growth': shape = expGrowth(0, dur, from, to); break
    case 'flash-crowd': shape = flashCrowd(0, Math.max(1, dur / 20), dur, from, to); break
    case 'sine': shape = sine(0, period, from, to); break
    case 'sawtooth': shape = sawtooth(0, period, from, to); break
    case 'square': shape = squareWave(0, period, Math.min(1, hold / 1800), from, to); break
    default: shape = step(0, from, to)
  }
  const withT0 = Object.assign((t: number) => (t < t0 ? from : shape(t - t0)), { max: Math.max(from, to) })
  return bool(p, 'noisyLoad') ? noisy(withT0, rng, num(p, 'noiseAmpPct') / 100) : withT0
}

// ---------------- scaling unit ----------------

export const unitParams: ParamSpec[] = [
  { key: 'cores', label: 'CPU cores', group: 'unit', kind: 'range', min: 1, max: 64, step: 1, default: 4,
    help: 'Physical cores per instance — the real bottleneck. Sizes the CPU pool. With cores: 1, cpu is literally Node\'s eventLoopUtilization.' },
  ...distParams({
    key: 'cpuTimeMs', label: 'CPU time', group: 'unit',
    help: 'Per-request CPU demand: time actually spent executing on a core.',
    base: { min: 1, max: 500, step: 1, default: 10, unit: 'ms' },
  }),
  ...distParams({
    key: 'ioWaitMs', label: 'I/O wait', group: 'unit',
    help: 'Per-request time spent waiting on I/O (DB, network) — doesn\'t consume a core, but still occupies the worker holding the request.',
    base: { min: 0, max: 2000, step: 10, default: 90, unit: 'ms' },
  }),
  { key: 'workers', label: 'workers', group: 'unit', kind: 'range', min: 1, max: 512, step: 1, default: 40,
    activeWhen: { unlimitedWorkers: 'false' },
    help: 'Worker slots per instance — requests served concurrently (threads / event-loop tasks). Independent of CPU cores: cores bound compute, workers bound how many requests can be in flight (each holding a worker across its CPU + I/O time). The classic reference shape is ceil(cores*(cpuTime+ioWait)/cpuTime) — 40 at the defaults — but real servers let you misconfigure this, which is the point.' },
  { key: 'unlimitedWorkers', label: 'unlimited workers', group: 'unit', kind: 'toggle', default: false,
    help: 'Bypass the workers knob with an effectively-unbounded pool — an explicit node.js-style "don\'t bound the worker pool" knob. The CPU pool stays bounded, so admission control moves to an unbounded wait for a core instead.' },
  { key: 'queueSlots', label: 'queue slots', group: 'unit', kind: 'range', min: 0, max: 512, step: 1, default: 32,
    help: 'Waiting room beyond the worker pool before rejecting. 0 = reject immediately when full.' },
  { key: 'poisonProb', label: 'worker poison probability', group: 'unit', kind: 'range', min: 0, max: 0.01, step: 0.0001, default: 0,
    help: 'Chance a served request permanently retires the worker that served it (never returns to the pool) — models a leaked thread in a misconfigured server that never recycles workers.' },
  { key: 'dbPoolSlots', label: 'shared DB pool slots', group: 'unit', kind: 'range', min: 0, max: 50, step: 1, default: 0,
    help: 'Shared DB connection pool across the WHOLE cluster. 0 = disabled (no shared bottleneck). >0 = every request also needs one of these shared slots — unlike cores/workers, scaling out instances does NOT scale this. The classic "autoscaled app exhausts DB connections" failure.' },
  { key: 'dbQueryMs', label: 'DB query time', group: 'unit', kind: 'range', min: 1, max: 500, step: 1, default: 20, unit: 'ms',
    help: 'How long a request holds a DB connection slot. Only matters when shared DB pool slots > 0.' },
  ...distParams({
    key: 'bootSec', label: 'boot time', group: 'unit',
    help: 'Delay from launch until an instance can serve. The main source of dead time.',
    base: { min: 0, max: 600, step: 5, default: 120, unit: 's' },
  }),
  { key: 'replaceDeadSec', label: 'replace dead after', group: 'unit', kind: 'range', min: 0, max: 600, step: 10, default: 60, unit: 's',
    help: 'Like an ASG health check: a crashed instance is relaunched after this delay.' },
  { key: 'hungCpu', label: 'CPU reported while hung', group: 'unit', kind: 'select', default: 'slots', options: [
    { value: 'slots', label: 'slots busy (honest)' }, { value: 'idle', label: '0% — stuck on I/O' }, { value: 'spinning', label: '100% — GC / spin' },
  ], help: 'What the metrics agent reports for a hung instance. The autoscaler believes it.' },
]

/** Requests per second one instance can serve at 100% CPU — the CPU-bound ceiling. I/O overlaps for free given enough workers. */
export function unitCapacity(p: Params): number {
  return num(p, 'cores') * 1000 / num(p, 'cpuTimeMs')
}

/** Worker-pool size used when `unlimitedWorkers` is set — effectively unbounded in-flight requests. */
const UNBOUNDED_WORKERS = 5_000

/**
 * Builds `InstanceOpts` from scenario params.
 *
 * Two easy-to-miss fixes baked in below:
 * - `cpuPool.queueLimit` is set to `workers`, not left at its default of 0. Admission control
 *   happens once, at `workerPool.tryAcquire()`; a request that's already "in" the envelope must be
 *   able to wait for a free core rather than being rejected mid-flight just because the io/cpu steps
 *   run sequentially. Without this, any transient cpu contention would reject requests outright,
 *   defeating the point of sizing `workerPool` larger than `cores` in the first place.
 * - `steps[].duration` is a raw sim-time value (the sim's base unit is seconds — see `bootSec`,
 *   `healthCheckSec`), but `cpuTimeMs`/`ioWaitMs` are authored in milliseconds, so each sampled draw
 *   must be divided by 1000. Missing this divides nothing: a request would hold its worker for
 *   `cpuTimeMs + ioWaitMs` *seconds* instead of milliseconds — 1000x too long, saturating the
 *   worker/cpu pools almost instantly.
 *
 * The `io` pool is sized to `workers`, so it can never be the
 * bottleneck: every request holding a worker can always be in its I/O step at once.
 */
export function instanceOpts(p: Params, rng: Rng): InstanceOpts {
  const hung = str(p, 'hungCpu')
  const cores = num(p, 'cores')
  const cpuTimeMs = num(p, 'cpuTimeMs'), ioWaitMs = num(p, 'ioWaitMs')

  // Workers are an explicit knob, deliberately decoupled from `cores`: cores bound compute,
  // workers bound concurrency. Fewer workers than cores is legal (starved cores); more than
  // cores is the usual config (I/O waits on the worker, not on the core).
  const workers = bool(p, 'unlimitedWorkers') ? UNBOUNDED_WORKERS : num(p, 'workers')

  return {
    bootTime: () => sampleDist(rng, p, 'bootSec'),
    workerPool: { slots: workers, queueLimit: num(p, 'queueSlots'), poisonProb: num(p, 'poisonProb') },
    cpuPool: { slots: cores, queueLimit: workers },
    steps: () => {
      const dbSlots = num(p, 'dbPoolSlots')
      const plan: Step[] = [{ pool: 'io', scope: 'instance', duration: sampleDist(rng, p, 'ioWaitMs') / 1000 }]
      if (dbSlots > 0) plan.push({ pool: 'db', scope: 'cluster', duration: num(p, 'dbQueryMs') / 1000 })
      plan.push({ pool: 'cpu', scope: 'instance', duration: sampleDist(rng, p, 'cpuTimeMs') / 1000 })
      return plan
    },
    instancePools: { io: { slots: workers } }, // I/O wait doesn't contend on a bounded resource of its own; the worker envelope already bounds concurrency
    hungCpu: hung === 'idle' ? 0 : hung === 'spinning' ? 1 : undefined,
    rollUniform: () => rng.next(), // real roll for workerPool.poisonProb — Instance's own default (rollUniform omitted) never poisons, so this must be supplied for poisonProb to do anything
  }
}

export function lbOpts(p: Params): LbOpts {
  const interval = num(p, 'healthCheckSec')
  return interval > 0
    ? {
        healthCheck: {
          interval, timeout: num(p, 'healthCheckTimeoutSec'),
          unhealthyAfter: num(p, 'unhealthyAfter'), healthyAfter: num(p, 'healthyAfter'),
        },
      }
    : {}
}

export function clusterOpts(p: Params): ClusterOpts {
  const d = num(p, 'replaceDeadSec')
  const dbSlots = num(p, 'dbPoolSlots')
  return {
    ...(d > 0 ? { replaceDeadAfter: d } : {}),
    // Generous queueLimit deliberately: this should show up as latency, not as a second
    // source of rejections — the pedagogical point is "scaling doesn't help", not "scaling
    // doesn't help AND also causes errors", which would muddy the demo.
    ...(dbSlots > 0 ? { clusterPools: { db: { slots: dbSlots, queueLimit: 1000 } } } : {}),
  }
}

// ---------------- autoscaler ----------------

const hpa = { algo: 'hpa' }
const aws = { algo: ['aws-target', 'aws-step', 'aws-simple'] }
const awsWarm = { algo: ['aws-target', 'aws-step'] }
const awsAlarm = { algo: ['aws-step', 'aws-simple'] }

export const scalerParams: ParamSpec[] = [
  { key: 'algo', label: 'algorithm', group: 'scaler', kind: 'select', default: 'hpa', options: [
    { value: 'hpa', label: 'Kubernetes HPA' },
    { value: 'aws-target', label: 'AWS target tracking' },
    { value: 'aws-step', label: 'AWS step scaling' },
    { value: 'aws-simple', label: 'AWS simple scaling' },
  ], help: 'Which real-world controller to emulate. Each follows its documented algorithm and defaults.' },
  { key: 'minInstances', label: 'min', group: 'scaler', kind: 'range', min: 0, max: 50, step: 1, default: 1,
    help: 'Never scale below this.' },
  { key: 'maxInstances', label: 'max', group: 'scaler', kind: 'range', min: 1, max: 1000, step: 1, default: 100,
    help: 'Never scale above this. Also your bill ceiling.' },

  // --- metrics pipeline (shared by every algorithm) ---
  { key: 'metricsResolutionSec', label: 'metrics scrape resolution', group: 'scaler', kind: 'range', min: 5, max: 120, step: 5, default: 15, unit: 's',
    help: 'How often the metrics pipeline itself scrapes each instance — metrics-server\'s --metric-resolution (default 15 s). Every algorithm reads from this same underlying scrape stream: HPA takes the latest computed rate (no averaging of its own), CloudWatch-style controllers average scrapes within their own datapoint period.' },

  // --- health checks (k8s readiness probe / AWS target group health check) ---
  { key: 'healthCheckSec', label: 'LB health check interval', group: 'scaler', kind: 'range', min: 0, max: 120, step: 5, default: 10, unit: 's',
    help: 'How often the load balancer probes instances. 0 = LB sees instance state instantly (unrealistic).' },
  { key: 'healthCheckTimeoutSec', label: 'LB health check timeout', group: 'scaler', kind: 'range', min: 0, max: 60, step: 1, default: 5, unit: 's',
    help: 'Max time the LB waits for a probe response before giving up on that attempt — like a real HTTP health check timeout. 0 = instant (unrealistic): a hung instance fails the very check tick that finds it hung, instead of only after waiting this long. A ready, responsive instance always answers instantly regardless of this value; only a hung one actually waits.' },
  { key: 'unhealthyAfter', label: 'unhealthy after', group: 'scaler', kind: 'range', min: 1, max: 10, step: 1, default: 3, unit: 'checks',
    help: 'Consecutive failed probes before the LB stops routing to an instance.' },
  { key: 'healthyAfter', label: 'healthy after', group: 'scaler', kind: 'range', min: 1, max: 10, step: 1, default: 2, unit: 'checks',
    help: 'Consecutive passed probes before a recovered instance gets traffic again.' },

  // --- scaling metrics (shared by every algorithm — AWS uses the first toggled-on one; HPA uses all of them, taking the max) ---
  { key: 'metricCpu', label: 'CPU utilization', group: 'scaler', kind: 'toggle', default: true,
    help: 'Scale on mean CPU pool busy fraction across pods.' },
  { key: 'metricCpuTarget', label: 'CPU target', group: 'scaler', kind: 'range', min: 0.1, max: 1, step: 0.05, default: 0.5,
    help: 'Target utilization for the CPU metric.', activeWhen: { metricCpu: 'true' } },
  { key: 'metricWorker', label: 'worker pool utilization', group: 'scaler', kind: 'toggle', default: false,
    help: 'Scale on mean worker-pool busy fraction — saturates much later than CPU on a pool sized above cores.' },
  { key: 'metricWorkerTarget', label: 'worker target', group: 'scaler', kind: 'range', min: 0.1, max: 1, step: 0.05, default: 0.7,
    help: 'Target utilization for the worker-pool metric.', activeWhen: { metricWorker: 'true' } },
  { key: 'metricQueue', label: 'queue depth', group: 'scaler', kind: 'toggle', default: false,
    help: 'Scale on mean requests waiting per pod.' },
  { key: 'metricQueueTarget', label: 'queue target', group: 'scaler', kind: 'range', min: 1, max: 50, step: 1, default: 5,
    help: 'Target queue depth per pod.', activeWhen: { metricQueue: 'true' } },
  { key: 'metricRps', label: 'requests/s per pod', group: 'scaler', kind: 'toggle', default: false,
    help: 'Scale on mean served requests/s per pod — a throughput target instead of a utilization one.' },
  { key: 'metricRpsTarget', label: 'rps target', group: 'scaler', kind: 'range', min: 1, max: 500, step: 1, default: 50,
    help: 'Target requests/s per pod.', activeWhen: { metricRps: 'true' } },
  { key: 'metricLatency', label: 'latency (mean, OK)', group: 'scaler', kind: 'toggle', default: false,
    help: 'Scale on mean end-to-end latency, cluster-wide — NOT a capacity signal; the same value is reported for every pod. See the runaway-latency demo for why this is a trap.' },
  { key: 'metricLatencyTarget', label: 'latency target (ms)', group: 'scaler', kind: 'range', min: 10, max: 2000, step: 10, default: 200,
    help: 'Target mean latency in ms.', activeWhen: { metricLatency: 'true' } },

  // --- k8s HPA ---
  { key: 'hpaTolerance', label: 'tolerance', group: 'scaler', kind: 'range', min: 0, max: 0.5, step: 0.01, default: 0.1,
    help: 'No action while |avg/target − 1| ≤ tolerance. Default 0.1.', activeWhen: hpa },
  { key: 'hpaSyncSec', label: 'sync period', group: 'scaler', kind: 'range', min: 5, max: 300, step: 5, default: 15, unit: 's',
    help: '--horizontal-pod-autoscaler-sync-period. Default 15 s.', activeWhen: hpa },
  { key: 'hpaReadinessDelaySec', label: 'initial readiness delay', group: 'scaler', kind: 'range', min: 0, max: 300, step: 5, default: 30, unit: 's',
    help: 'Pods ready for less than this are set aside: 0% on scale-up, 100% of target on scale-down. Default 30 s.', activeWhen: hpa },
  { key: 'hpaDownStabilizationSec', label: 'scale-down stabilization', group: 'scaler', kind: 'range', min: 0, max: 900, step: 15, default: 300, unit: 's',
    help: 'Scale-down uses the highest recommendation seen in this window. Default 300 s.', activeWhen: hpa },
  { key: 'hpaScaleUpPods', label: 'scale-up policy: pods', group: 'scaler', kind: 'range', min: 0, max: 50, step: 1, default: 4, unit: '/15 s',
    help: 'behavior.scaleUp policy: at most this many pods added per 15 s. Combined with the percent policy via selectPolicy Max. Default 4.', activeWhen: hpa },
  { key: 'hpaScaleUpPercent', label: 'scale-up policy: percent', group: 'scaler', kind: 'range', min: 0, max: 1000, step: 10, default: 100, unit: '%/15 s',
    help: 'behavior.scaleUp policy: at most this percent of current replicas added per 15 s. Default 100.', activeWhen: hpa },

  // --- AWS common ---
  { key: 'awsPeriodSec', label: 'datapoint period', group: 'scaler', kind: 'range', min: 10, max: 300, step: 10, default: 60, unit: 's',
    help: 'CloudWatch metric period. EC2 detailed monitoring: 60 s (basic: 300 s).', activeWhen: aws },
  { key: 'awsMetricDelaySec', label: 'metric delay', group: 'scaler', kind: 'range', min: 0, max: 300, step: 10, default: 60, unit: 's',
    help: 'Time until a datapoint is visible to alarms. CloudWatch typically 1–2 min for EC2 metrics.', activeWhen: aws },
  { key: 'awsWarmupSec', label: 'instance warmup', group: 'scaler', kind: 'range', min: 0, max: 900, step: 15, default: 300, unit: 's',
    help: 'Until warmed up, an instance is excluded from the aggregated metric but counted toward desired capacity for scale-out; scale-in is blocked meanwhile. Default = default cooldown, 300 s.', activeWhen: awsWarm },

  // --- AWS target tracking ---
  { key: 'awsTarget', label: 'target value', group: 'scaler', kind: 'range', min: 0.1, max: 1, step: 0.05, default: 0.5,
    help: 'Target utilization. Scale-out adds ceil(current × metric / target) − current.', activeWhen: { algo: 'aws-target' } },
  { key: 'awsHighPeriods', label: 'AlarmHigh datapoints', group: 'scaler', kind: 'range', min: 1, max: 15, step: 1, default: 3,
    help: 'Consecutive datapoints above target before scaling out. Docs do not state it; observed alarms use 3.', activeWhen: { algo: 'aws-target' } },
  { key: 'awsLowPeriods', label: 'AlarmLow datapoints', group: 'scaler', kind: 'range', min: 1, max: 30, step: 1, default: 15,
    help: 'Consecutive datapoints below the low threshold before scaling in. Observed alarms use 15.', activeWhen: { algo: 'aws-target' } },
  { key: 'awsLowFactor', label: 'AlarmLow threshold', group: 'scaler', kind: 'range', min: 0.5, max: 1, step: 0.05, default: 0.9,
    help: 'Scale-in alarm threshold as a fraction of target (observed: 90%). The gap is the anti-flapping buffer.', activeWhen: { algo: 'aws-target' } },
  { key: 'awsDisableScaleIn', label: 'disable scale-in', group: 'scaler', kind: 'toggle', default: false,
    help: 'Target tracking option: only ever scale out.', activeWhen: { algo: 'aws-target' } },

  // --- AWS step / simple alarms ---
  { key: 'awsOutThreshold', label: 'scale-out alarm above', group: 'scaler', kind: 'range', min: 0.1, max: 1, step: 0.05, default: 0.6,
    help: 'Scale-out alarm breaches when the metric is above this.', activeWhen: awsAlarm },
  { key: 'awsOutPeriods', label: 'scale-out datapoints', group: 'scaler', kind: 'range', min: 1, max: 15, step: 1, default: 3,
    help: 'Consecutive datapoints in breach before the scale-out alarm fires.', activeWhen: awsAlarm },
  { key: 'awsInThreshold', label: 'scale-in alarm below', group: 'scaler', kind: 'range', min: 0, max: 0.9, step: 0.05, default: 0.3,
    help: 'Scale-in alarm breaches when the metric is below this.', activeWhen: awsAlarm },
  { key: 'awsInPeriods', label: 'scale-in datapoints', group: 'scaler', kind: 'range', min: 1, max: 30, step: 1, default: 15,
    help: 'Consecutive datapoints in breach before the scale-in alarm fires.', activeWhen: awsAlarm },
  { key: 'awsOutSteps', label: 'scale-out steps', group: 'scaler', kind: 'text', default: '0-0.1:+10%, 0.1-0.2:+20%, 0.2-:+30%',
    help: 'Step adjustments relative to the breach size: lower-upper:adjust. Adjust is instances or percent of current capacity; AWS rounding (toward zero, min 1).', activeWhen: { algo: 'aws-step' } },
  { key: 'awsInSteps', label: 'scale-in steps', group: 'scaler', kind: 'text', default: '0-0.1:-10%, 0.1-0.2:-20%, 0.2-:-30%',
    help: 'Step adjustments for scale-in, relative to how far below the threshold the metric is.', activeWhen: { algo: 'aws-step' } },
  { key: 'awsOutAdjust', label: 'scale-out adjustment', group: 'scaler', kind: 'text', default: '+1',
    help: 'Simple scaling: single adjustment per alarm, e.g. +1 or +50%.', activeWhen: { algo: 'aws-simple' } },
  { key: 'awsInAdjust', label: 'scale-in adjustment', group: 'scaler', kind: 'text', default: '-1',
    help: 'Simple scaling: single adjustment per alarm, e.g. -1 or -10%.', activeWhen: { algo: 'aws-simple' } },
  { key: 'awsCooldownSec', label: 'cooldown', group: 'scaler', kind: 'range', min: 0, max: 900, step: 15, default: 300, unit: 's',
    help: 'Simple scaling: no further scaling activity until the cooldown expires. Default 300 s.', activeWhen: { algo: 'aws-simple' } },
]

export interface Controller { start(): void; readonly metric: number; readonly desired: number; readonly metricKind: 'utilization' | 'absolute' }

const METRIC_IDS = ['cpu', 'worker', 'queue', 'rps', 'latency'] as const
type MetricId = typeof METRIC_IDS[number]
const METRIC_PARAM: Record<MetricId, { toggle: string; target: string }> = {
  cpu: { toggle: 'metricCpu', target: 'metricCpuTarget' },
  worker: { toggle: 'metricWorker', target: 'metricWorkerTarget' },
  queue: { toggle: 'metricQueue', target: 'metricQueueTarget' },
  rps: { toggle: 'metricRps', target: 'metricRpsTarget' },
  latency: { toggle: 'metricLatency', target: 'metricLatencyTarget' },
}

export function attachController(sim: Sim, cluster: Cluster, p: Params, stats: Stats): Controller {
  const interval = num(p, 'metricsResolutionSec')
  const active = METRIC_IDS.filter((id) => bool(p, METRIC_PARAM[id].toggle))
  const ids: MetricId[] = active.length ? active : ['cpu']

  const podMetricsFor = (id: MetricId): PodMetrics => {
    const def = id === 'latency' ? latencyMetric(stats, interval) : metricRegistry[id]
    const m = new PodMetrics(sim, cluster, { sampleInterval: interval, source: def.source })
    m.start()
    return m
  }

  const min = num(p, 'minInstances'), max = num(p, 'maxInstances')
  const cw = { period: num(p, 'awsPeriodSec'), metricDelay: num(p, 'awsMetricDelaySec'), warmup: num(p, 'awsWarmupSec') }
  let c: Controller
  switch (str(p, 'algo')) {
    case 'aws-target':
      c = new AwsTargetTracking(sim, cluster, podMetricsFor(ids[0]!), {
        ...cw, min, max, target: num(p, 'awsTarget'),
        highEvalPeriods: num(p, 'awsHighPeriods'), lowEvalPeriods: num(p, 'awsLowPeriods'), lowFactor: num(p, 'awsLowFactor'),
        disableScaleIn: bool(p, 'awsDisableScaleIn'),
      })
      break
    case 'aws-step':
      c = new AwsStepScaling(sim, cluster, podMetricsFor(ids[0]!), {
        ...cw, min, max,
        outThreshold: num(p, 'awsOutThreshold'), outSteps: str(p, 'awsOutSteps'), outEvalPeriods: num(p, 'awsOutPeriods'),
        inThreshold: num(p, 'awsInThreshold'), inSteps: str(p, 'awsInSteps'), inEvalPeriods: num(p, 'awsInPeriods'),
      })
      break
    case 'aws-simple':
      c = new AwsSimpleScaling(sim, cluster, podMetricsFor(ids[0]!), {
        ...cw, min, max, cooldown: num(p, 'awsCooldownSec'),
        outThreshold: num(p, 'awsOutThreshold'), outAdjust: str(p, 'awsOutAdjust'), outEvalPeriods: num(p, 'awsOutPeriods'),
        inThreshold: num(p, 'awsInThreshold'), inAdjust: str(p, 'awsInAdjust'), inEvalPeriods: num(p, 'awsInPeriods'),
      })
      break
    default:
      c = new Hpa(sim, cluster, {
        min, max,
        metrics: ids.map((id) => ({
          metrics: podMetricsFor(id), target: num(p, METRIC_PARAM[id].target), id,
          kind: id === 'latency' ? 'absolute' : metricRegistry[id].kind,
        })),
        tolerance: num(p, 'hpaTolerance'), syncPeriod: num(p, 'hpaSyncSec'),
        initialReadinessDelay: num(p, 'hpaReadinessDelaySec'),
        downStabilization: num(p, 'hpaDownStabilizationSec'),
        scaleUpPods: num(p, 'hpaScaleUpPods'), scaleUpPercent: num(p, 'hpaScaleUpPercent'),
      })
  }
  c.start()
  return c
}

/** Utilization the controller aims for — used to size the cluster for a given load. Always
 *  CPU-shaped (see spec §9: general non-CPU sizing math is out of scope) — reads the CPU
 *  metric's target when it's toggled on, else falls back to the registry's own CPU default. */
export function targetUtilization(p: Params): number {
  switch (str(p, 'algo')) {
    case 'aws-target': return num(p, 'awsTarget')
    case 'aws-step': case 'aws-simple': return (num(p, 'awsOutThreshold') + num(p, 'awsInThreshold')) / 2
    default: return bool(p, 'metricCpu') ? num(p, 'metricCpuTarget') : metricRegistry.cpu.defaultTarget
  }
}

/** Instances needed for `rps` at the controller's target utilization. */
export function neededInstances(p: Params, rps: number): number {
  return rps / unitCapacity(p) / targetUtilization(p)
}

// ---------------- faults ----------------

const scoped = { faultKind: ['kill', 'hang', 'slow'] }
const timed = { faultKind: ['hang', 'slow', 'upstreamOutage', 'upstreamSlow'] }

export const faultParams: ParamSpec[] = [
  { key: 'faultKind', label: 'fault', group: 'fault', kind: 'select', default: 'none', options: [
    { value: 'none', label: 'none' },
    { value: 'kill', label: 'instances die' },
    { value: 'hang', label: 'instances hang, then recover' },
    { value: 'slow', label: 'instances get slow' },
    { value: 'rollingRestart', label: 'rolling restart (deploy)' },
  ], help: 'Something goes wrong at a chosen time. Watch what the autoscaler makes of it.' },
  { key: 'faultAtSec', label: 'fault at', group: 'fault', kind: 'range', min: 0, max: 3600, step: 30, default: 1200, unit: 's',
    help: 'When the fault starts (scenario time).', activeWhen: { faultKind: ['kill', 'hang', 'slow', 'rollingRestart', 'upstreamOutage', 'upstreamSlow'] } },
  { key: 'faultCount', label: 'instances affected', group: 'fault', kind: 'range', min: 1, max: 50, step: 1, default: 2,
    help: 'How many instances the fault hits (oldest first).', activeWhen: scoped },
  { key: 'faultDurationSec', label: 'duration', group: 'fault', kind: 'range', min: 10, max: 1800, step: 10, default: 300, unit: 's',
    help: 'How long the fault lasts before things recover on their own.', activeWhen: timed },
  { key: 'faultFactor', label: 'slowdown factor', group: 'fault', kind: 'range', min: 1, max: 50, step: 1, default: 5,
    help: 'Service time multiplier while slow.', activeWhen: { faultKind: ['slow', 'upstreamSlow'] } },
  { key: 'rollingBatch', label: 'batch', group: 'fault', kind: 'range', min: 1, max: 20, step: 1, default: 1, unit: 'instances',
    help: 'Instances replaced per deploy step.', activeWhen: { faultKind: 'rollingRestart' } },
  { key: 'rollingIntervalSec', label: 'batch interval', group: 'fault', kind: 'range', min: 10, max: 600, step: 10, default: 60, unit: 's',
    help: 'Time between deploy steps.', activeWhen: { faultKind: 'rollingRestart' } },
]

/** Faults described by params, with `at` shifted by `t0` (scenario time → sim time). */
export function faults(p: Params, t0: number): Fault[] {
  const at = t0 + num(p, 'faultAtSec')
  switch (str(p, 'faultKind')) {
    case 'kill': return [{ kind: 'kill', at, count: num(p, 'faultCount') }]
    case 'hang': return [{ kind: 'hang', at, count: num(p, 'faultCount'), duration: num(p, 'faultDurationSec') }]
    case 'slow': return [{ kind: 'slow', at, count: num(p, 'faultCount'), duration: num(p, 'faultDurationSec'), factor: num(p, 'faultFactor') }]
    case 'rollingRestart': return [{ kind: 'rollingRestart', at, batch: num(p, 'rollingBatch'), interval: num(p, 'rollingIntervalSec') }]
    case 'upstreamOutage': return [{ kind: 'upstreamOutage', at, duration: num(p, 'faultDurationSec') }]
    case 'upstreamSlow': return [{ kind: 'upstreamSlow', at, duration: num(p, 'faultDurationSec'), factor: num(p, 'faultFactor') }]
    default: return []
  }
}
