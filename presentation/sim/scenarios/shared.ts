import { logistic, ramp as linear, step, type Rate } from '../arrivals'
import type { Sim } from '../engine'
import type { Cluster } from '../cluster'
import { Autoscaler, targetTracking, threshold, type ScalerOpts } from '../scaler'
import { bool, num, str, type ParamSpec, type Params } from './types'

// ---------------- load ----------------

export const loadParams: ParamSpec[] = [
  { key: 'baseRps', label: 'base load', group: 'load', kind: 'range', min: 0, max: 2000, step: 10, default: 100, unit: 'rps' },
  { key: 'rps', label: 'load after ramp', group: 'load', kind: 'range', min: 10, max: 4000, step: 10, default: 400, unit: 'rps' },
  { key: 'ramp', label: 'ramp', group: 'load', kind: 'select', default: 'step', options: [
    { value: 'step', label: 'heaviside (step)' }, { value: 'linear', label: 'linear' }, { value: 'logistic', label: 'logistic' },
  ] },
  { key: 'rampSec', label: 'ramp time', group: 'load', kind: 'range', min: 10, max: 1800, step: 10, default: 300, unit: 's' },
  { key: 'quietSec', label: 'stable period before ramp', group: 'load', kind: 'range', min: 0, max: 900, step: 30, default: 300, unit: 's' },
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
  { key: 'latencyMs', label: 'service time', group: 'unit', kind: 'range', min: 5, max: 2000, step: 5, default: 100, unit: 'ms' },
  { key: 'concurrency', label: 'slots per instance', group: 'unit', kind: 'range', min: 1, max: 256, step: 1, default: 16 },
  { key: 'bootSec', label: 'boot time', group: 'unit', kind: 'range', min: 0, max: 600, step: 5, default: 120, unit: 's' },
]

/** Requests per second one instance can serve at 100%. */
export function unitCapacity(p: Params): number {
  return num(p, 'concurrency') * 1000 / num(p, 'latencyMs')
}

// ---------------- autoscaler ----------------

export const scalerParams: ParamSpec[] = [
  { key: 'algo', label: 'algorithm', group: 'scaler', kind: 'select', default: 'target', options: [
    { value: 'target', label: 'target tracking (HPA)' }, { value: 'threshold', label: 'threshold ± step' },
  ] },
  { key: 'targetCpu', label: 'target', group: 'scaler', kind: 'range', min: 0.1, max: 1, step: 0.05, default: 0.5, help: 'target tracking: utilization to aim for' },
  { key: 'tolerance', label: 'tolerance', group: 'scaler', kind: 'range', min: 0, max: 0.5, step: 0.01, default: 0.1, help: 'target tracking: dead band around target' },
  { key: 'upAt', label: 'scale up above', group: 'scaler', kind: 'range', min: 0.1, max: 1, step: 0.05, default: 0.7, help: 'threshold algo' },
  { key: 'downAt', label: 'scale down below', group: 'scaler', kind: 'range', min: 0, max: 0.9, step: 0.05, default: 0.3, help: 'threshold algo' },
  { key: 'stepSize', label: 'step', group: 'scaler', kind: 'range', min: 1, max: 20, step: 1, default: 1, unit: 'instances', help: 'threshold algo' },
  { key: 'periodSec', label: 'decision period', group: 'scaler', kind: 'range', min: 5, max: 600, step: 5, default: 30, unit: 's' },
  { key: 'windowSec', label: 'metric window', group: 'scaler', kind: 'range', min: 5, max: 600, step: 5, default: 60, unit: 's' },
  { key: 'metricDelaySec', label: 'metric delay', group: 'scaler', kind: 'range', min: 0, max: 300, step: 5, default: 0, unit: 's' },
  { key: 'upCooldownSec', label: 'scale-up cooldown', group: 'scaler', kind: 'range', min: 0, max: 900, step: 15, default: 0, unit: 's' },
  { key: 'downCooldownSec', label: 'scale-down cooldown', group: 'scaler', kind: 'range', min: 0, max: 900, step: 15, default: 0, unit: 's' },
  { key: 'stabilizationSec', label: 'scale-down stabilization', group: 'scaler', kind: 'range', min: 0, max: 900, step: 15, default: 0, unit: 's' },
  { key: 'countInFlight', label: 'account for booting instances', group: 'scaler', kind: 'toggle', default: false },
  { key: 'minInstances', label: 'min', group: 'scaler', kind: 'range', min: 0, max: 50, step: 1, default: 1 },
  { key: 'maxInstances', label: 'max', group: 'scaler', kind: 'range', min: 1, max: 1000, step: 1, default: 100 },
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
