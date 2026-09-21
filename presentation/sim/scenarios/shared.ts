import { logistic, ramp as linear, step, type Rate } from '../arrivals'
import type { Sim } from '../engine'
import type { Cluster, ClusterOpts } from '../cluster'
import type { Fault } from '../faults'
import type { InstanceOpts } from '../instance'
import type { LbOpts } from '../lb'
import { Autoscaler, targetTracking, threshold, type ScalerOpts } from '../scaler'
import type { Rng } from '../rng'
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
  { key: 'bootSec', label: 'boot time', group: 'unit', kind: 'range', min: 0, max: 600, step: 5, default: 120, unit: 's',
    help: 'Delay from launch until an instance can serve. The main source of dead time.' },
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
    bootTime: num(p, 'bootSec'),
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

export const scalerParams: ParamSpec[] = [
  { key: 'algo', label: 'algorithm', group: 'scaler', kind: 'select', default: 'target', options: [
    { value: 'target', label: 'target tracking (HPA)' }, { value: 'threshold', label: 'threshold ± step' },
  ], help: 'Target tracking: desired = ceil(current × metric / target), like k8s HPA. Threshold: add/remove a fixed step when the metric crosses a line.' },
  { key: 'targetCpu', label: 'target', group: 'scaler', kind: 'range', min: 0.1, max: 1, step: 0.05, default: 0.5,
    help: 'Utilization the controller aims for. Lower = more headroom, more cost.', activeWhen: { algo: 'target' } },
  { key: 'tolerance', label: 'tolerance', group: 'scaler', kind: 'range', min: 0, max: 0.5, step: 0.01, default: 0.1,
    help: 'Dead band: no action while |metric/target − 1| is within this. k8s default 0.1.', activeWhen: { algo: 'target' } },
  { key: 'upAt', label: 'scale up above', group: 'scaler', kind: 'range', min: 0.1, max: 1, step: 0.05, default: 0.7,
    help: 'Add `step` instances when the metric exceeds this.', activeWhen: { algo: 'threshold' } },
  { key: 'downAt', label: 'scale down below', group: 'scaler', kind: 'range', min: 0, max: 0.9, step: 0.05, default: 0.3,
    help: 'Remove `step` instances when the metric drops below this.', activeWhen: { algo: 'threshold' } },
  { key: 'stepSize', label: 'step', group: 'scaler', kind: 'range', min: 1, max: 20, step: 1, default: 1, unit: 'instances',
    help: 'Instances added or removed per decision.', activeWhen: { algo: 'threshold' } },
  { key: 'periodSec', label: 'decision period', group: 'scaler', kind: 'range', min: 5, max: 600, step: 5, default: 30, unit: 's',
    help: 'How often the controller evaluates and acts. k8s HPA: 15 s.' },
  { key: 'windowSec', label: 'metric window', group: 'scaler', kind: 'range', min: 5, max: 600, step: 5, default: 60, unit: 's',
    help: 'The metric is averaged over this trailing window. Smooths noise, adds lag.' },
  { key: 'metricDelaySec', label: 'metric delay', group: 'scaler', kind: 'range', min: 0, max: 300, step: 5, default: 0, unit: 's',
    help: 'Pipeline lag: the controller sees the metric as it was this long ago. CloudWatch ≈ 60 s.' },
  { key: 'upCooldownSec', label: 'scale-up cooldown', group: 'scaler', kind: 'range', min: 0, max: 900, step: 15, default: 0, unit: 's',
    help: 'Minimum time between scale-up actions. AWS ASG default 300 s.' },
  { key: 'downCooldownSec', label: 'scale-down cooldown', group: 'scaler', kind: 'range', min: 0, max: 900, step: 15, default: 0, unit: 's',
    help: 'Minimum time between scale-down actions.' },
  { key: 'stabilizationSec', label: 'scale-down stabilization', group: 'scaler', kind: 'range', min: 0, max: 900, step: 15, default: 0, unit: 's',
    help: 'Scale-down uses the highest desired size seen in this window. k8s default 300 s. 0 = off.' },
  { key: 'countInFlight', label: 'account for booting instances', group: 'scaler', kind: 'toggle', default: false,
    help: 'Compute desired from ready instances (what the metric measures) and treat booting ones as already ordered. Real autoscalers do not.' },
  { key: 'minInstances', label: 'min', group: 'scaler', kind: 'range', min: 0, max: 50, step: 1, default: 1,
    help: 'Never scale below this.' },
  { key: 'maxInstances', label: 'max', group: 'scaler', kind: 'range', min: 1, max: 1000, step: 1, default: 100,
    help: 'Never scale above this. Also your bill ceiling.' },
]

export function scalerOpts(p: Params): ScalerOpts {
  const policy = str(p, 'algo') === 'threshold'
    ? threshold({ up: num(p, 'upAt'), down: num(p, 'downAt'), step: num(p, 'stepSize') })
    : targetTracking({ target: num(p, 'targetCpu'), tolerance: num(p, 'tolerance') })
  const stab = num(p, 'stabilizationSec')
  return {
    period: num(p, 'periodSec'),
    sampleInterval: 5,
    window: num(p, 'windowSec'),
    metricDelay: num(p, 'metricDelaySec'),
    scaleUpCooldown: num(p, 'upCooldownSec'),
    scaleDownCooldown: num(p, 'downCooldownSec'),
    stabilizationWindow: stab > 0 ? stab : undefined,
    countInFlight: bool(p, 'countInFlight'),
    min: num(p, 'minInstances'),
    max: num(p, 'maxInstances'),
    policy,
  }
}

export function attachScaler(sim: Sim, cluster: Cluster, signal: () => number, p: Params): Autoscaler {
  const s = new Autoscaler(sim, cluster, signal, scalerOpts(p))
  s.start()
  return s
}

/** Instances needed for `rps` at the scaler's target utilization. */
export function neededInstances(p: Params, rps: number): number {
  const target = str(p, 'algo') === 'threshold' ? (num(p, 'upAt') + num(p, 'downAt')) / 2 : num(p, 'targetCpu')
  return rps / unitCapacity(p) / target
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
