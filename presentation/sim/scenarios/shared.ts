import { logistic, ramp as linear, step, type Rate } from '../arrivals'
import type { Sim } from '../engine'
import type { Cluster, ClusterOpts } from '../cluster'
import type { Fault } from '../faults'
import type { InstanceOpts } from '../instance'
import type { LbOpts } from '../lb'
import { AwsSimpleScaling, AwsStepScaling, AwsTargetTracking } from '../controllers/aws'
import { Hpa } from '../controllers/hpa'
import { PodMetrics } from '../controllers/metrics'
import type { Rng } from '../rng'
import { distParams, sampleDist } from './dist'
import { bool, num, str, type ParamSpec, type Params } from './types'

// ---------------- load ----------------

export const loadParams: ParamSpec[] = [
  { key: 'baseRps', label: 'base load', group: 'load', kind: 'range', min: 0, max: 2000, step: 10, default: 100, unit: 'rps',
    help: 'Steady request rate before the ramp. The cluster starts sized for this.' },
  { key: 'rps', label: 'load after ramp', group: 'load', kind: 'range', min: 10, max: 4000, step: 10, default: 400, unit: 'rps',
    help: 'Request rate the ramp ends at, held until the end of the run.' },
  { key: 'ramp', label: 'ramp', group: 'load', kind: 'select', default: 'step', options: [
    { value: 'step', label: 'heaviside (step)' }, { value: 'linear', label: 'linear' }, { value: 'logistic', label: 'logistic' },
  ], help: 'Shape of the transition from base load to final load.' },
  { key: 'rampSec', label: 'ramp time', group: 'load', kind: 'range', min: 10, max: 1800, step: 10, default: 300, unit: 's',
    help: 'How long the ramp takes (linear / logistic only).', activeWhen: { ramp: ['linear', 'logistic'] } },
  { key: 'quietSec', label: 'stable period before ramp', group: 'load', kind: 'range', min: 0, max: 900, step: 30, default: 300, unit: 's',
    help: 'Time at base load before the ramp starts, so the "before" state is visible.' },
]

/** Rate profile: baseRps until t0, then ramp to rps. Absolute time. */
export function loadProfile(p: Params, t0: number): Rate {
  const from = num(p, 'baseRps'), to = num(p, 'rps'), dur = num(p, 'rampSec')
  let shape: Rate
  switch (str(p, 'ramp')) {
    case 'linear': shape = linear(0, dur, from, to); break
    case 'logistic': shape = logistic(0, dur, from, to); break
    default: shape = step(0, from, to)
  }
  return Object.assign((t: number) => (t < t0 ? from : shape(t - t0)), { max: Math.max(from, to) })
}

// ---------------- scaling unit ----------------

export const unitParams: ParamSpec[] = [
  { key: 'latencyMs', label: 'service time', group: 'unit', kind: 'range', min: 5, max: 2000, step: 5, default: 100, unit: 'ms',
    help: 'Mean time one request occupies a slot (exponentially distributed).' },
  { key: 'concurrency', label: 'slots per instance', group: 'unit', kind: 'range', min: 1, max: 256, step: 1, default: 16,
    help: 'Requests one instance handles at once (threads / workers). Beyond this it rejects. Capacity = slots × 1000 / service time.' },
  ...distParams({
    key: 'bootSec', label: 'boot time', group: 'unit',
    help: 'Delay from launch until an instance can serve. The main source of dead time.',
    base: { min: 0, max: 600, step: 5, default: 120, unit: 's' },
  }),
  { key: 'healthCheckSec', label: 'LB health check interval', group: 'unit', kind: 'range', min: 0, max: 120, step: 5, default: 10, unit: 's',
    help: 'How often the load balancer probes instances. 0 = LB sees instance state instantly (unrealistic).' },
  { key: 'unhealthyAfter', label: 'unhealthy after', group: 'unit', kind: 'range', min: 1, max: 10, step: 1, default: 3, unit: 'checks',
    help: 'Consecutive failed probes before the LB stops routing to an instance.' },
  { key: 'healthyAfter', label: 'healthy after', group: 'unit', kind: 'range', min: 1, max: 10, step: 1, default: 2, unit: 'checks',
    help: 'Consecutive passed probes before a recovered instance gets traffic again.' },
  { key: 'replaceDeadSec', label: 'replace dead after', group: 'unit', kind: 'range', min: 0, max: 600, step: 10, default: 60, unit: 's',
    help: 'Like an ASG health check: a crashed instance is relaunched after this delay.' },
  { key: 'hungCpu', label: 'CPU reported while hung', group: 'unit', kind: 'select', default: 'slots', options: [
    { value: 'slots', label: 'slots busy (honest)' }, { value: 'idle', label: '0% — stuck on I/O' }, { value: 'spinning', label: '100% — GC / spin' },
  ], help: 'What the metrics agent reports for a hung instance. The autoscaler believes it.' },
]

/** Requests per second one instance can serve at 100%. */
export function unitCapacity(p: Params): number {
  return num(p, 'concurrency') * 1000 / num(p, 'latencyMs')
}

export function instanceOpts(p: Params, rng: Rng): InstanceOpts {
  const hung = str(p, 'hungCpu')
  return {
    bootTime: () => sampleDist(rng, p, 'bootSec'),
    serviceTime: () => rng.exp(1000 / num(p, 'latencyMs')),
    concurrency: num(p, 'concurrency'),
    queueLimit: 0,
    hungCpu: hung === 'idle' ? 0 : hung === 'spinning' ? 1 : undefined,
  }
}

export function lbOpts(p: Params): LbOpts {
  const interval = num(p, 'healthCheckSec')
  return interval > 0
    ? { healthCheck: { interval, unhealthyAfter: num(p, 'unhealthyAfter'), healthyAfter: num(p, 'healthyAfter') } }
    : {}
}

export function clusterOpts(p: Params): ClusterOpts {
  const d = num(p, 'replaceDeadSec')
  return d > 0 ? { replaceDeadAfter: d } : {}
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

  // --- k8s HPA ---
  { key: 'hpaTarget', label: 'target utilization', group: 'scaler', kind: 'range', min: 0.1, max: 1, step: 0.05, default: 0.5,
    help: 'targetAverageUtilization. desired = ceil(current × avg / target).', activeWhen: hpa },
  { key: 'hpaTolerance', label: 'tolerance', group: 'scaler', kind: 'range', min: 0, max: 0.5, step: 0.01, default: 0.1,
    help: 'No action while |avg/target − 1| ≤ tolerance. Default 0.1.', activeWhen: hpa },
  { key: 'hpaSyncSec', label: 'sync period', group: 'scaler', kind: 'range', min: 5, max: 300, step: 5, default: 15, unit: 's',
    help: '--horizontal-pod-autoscaler-sync-period. Default 15 s.', activeWhen: hpa },
  { key: 'hpaMetricWindowSec', label: 'metric window', group: 'scaler', kind: 'range', min: 5, max: 120, step: 5, default: 15, unit: 's',
    help: 'metrics-server scrape interval; CPU usage is averaged over it. Default 15 s.', activeWhen: hpa },
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

export interface Controller { start(): void; readonly metric: number; readonly desired: number }

export function attachController(sim: Sim, cluster: Cluster, p: Params): Controller {
  const metrics = new PodMetrics(sim, cluster, { sampleInterval: 5 })
  metrics.start()
  const min = num(p, 'minInstances'), max = num(p, 'maxInstances')
  const cw = { period: num(p, 'awsPeriodSec'), metricDelay: num(p, 'awsMetricDelaySec'), warmup: num(p, 'awsWarmupSec') }
  let c: Controller
  switch (str(p, 'algo')) {
    case 'aws-target':
      c = new AwsTargetTracking(sim, cluster, metrics, {
        ...cw, min, max, target: num(p, 'awsTarget'),
        highEvalPeriods: num(p, 'awsHighPeriods'), lowEvalPeriods: num(p, 'awsLowPeriods'), lowFactor: num(p, 'awsLowFactor'),
        disableScaleIn: bool(p, 'awsDisableScaleIn'),
      })
      break
    case 'aws-step':
      c = new AwsStepScaling(sim, cluster, metrics, {
        ...cw, min, max,
        outThreshold: num(p, 'awsOutThreshold'), outSteps: str(p, 'awsOutSteps'), outEvalPeriods: num(p, 'awsOutPeriods'),
        inThreshold: num(p, 'awsInThreshold'), inSteps: str(p, 'awsInSteps'), inEvalPeriods: num(p, 'awsInPeriods'),
      })
      break
    case 'aws-simple':
      c = new AwsSimpleScaling(sim, cluster, metrics, {
        ...cw, min, max, cooldown: num(p, 'awsCooldownSec'),
        outThreshold: num(p, 'awsOutThreshold'), outAdjust: str(p, 'awsOutAdjust'), outEvalPeriods: num(p, 'awsOutPeriods'),
        inThreshold: num(p, 'awsInThreshold'), inAdjust: str(p, 'awsInAdjust'), inEvalPeriods: num(p, 'awsInPeriods'),
      })
      break
    default:
      c = new Hpa(sim, cluster, metrics, {
        min, max, target: num(p, 'hpaTarget'), tolerance: num(p, 'hpaTolerance'), syncPeriod: num(p, 'hpaSyncSec'),
        metricWindow: num(p, 'hpaMetricWindowSec'), initialReadinessDelay: num(p, 'hpaReadinessDelaySec'),
        downStabilization: num(p, 'hpaDownStabilizationSec'),
        scaleUpPods: num(p, 'hpaScaleUpPods'), scaleUpPercent: num(p, 'hpaScaleUpPercent'),
      })
  }
  c.start()
  return c
}

/** Utilization the controller aims for — used to size the cluster for a given load. */
export function targetUtilization(p: Params): number {
  switch (str(p, 'algo')) {
    case 'aws-target': return num(p, 'awsTarget')
    case 'aws-step': case 'aws-simple': return (num(p, 'awsOutThreshold') + num(p, 'awsInThreshold')) / 2
    default: return num(p, 'hpaTarget')
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
