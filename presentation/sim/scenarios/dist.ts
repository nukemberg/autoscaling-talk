import type { Rng } from '../rng'
import { num, str, type ParamGroup, type ParamSpec, type Params } from './types'

/**
 * A value that can be a fixed number or sampled per-draw around a floor/median.
 * - fixed: exactly the base value.
 * - shifted-exp: base (floor) + Exp(mean = tail) — a hard minimum plus long-tail stragglers.
 * - lognormal: multiplicative spread around base as the median.
 */
export type DistKind = 'fixed' | 'shifted-exp' | 'lognormal'

interface DistBase { min: number; max: number; step: number; default: number; unit?: string }

/** Param specs for a base value plus a selectable distribution around it. Pair with `sampleDist`. */
export function distParams(opts: { key: string; label: string; group: ParamGroup; help: string; base: DistBase }): ParamSpec[] {
  const { key, label, group, help, base } = opts
  const distKey = `${key}Dist`
  const distActive = { [distKey]: ['shifted-exp'] }
  const lognormalActive = { [distKey]: ['lognormal'] }
  return [
    { key, label, group, kind: 'range', ...base, help },
    { key: distKey, label: `${label}: distribution`, group, kind: 'select', default: 'fixed', options: [
      { value: 'fixed', label: 'fixed' },
      { value: 'shifted-exp', label: 'floor + exponential tail (stragglers)' },
      { value: 'lognormal', label: 'lognormal (multiplicative spread)' },
    ], help: `How ${label} varies per draw. "${label}" above is the floor (shifted-exp) or median (lognormal).` },
    { key: `${key}Tail`, label: `${label}: tail mean`, group, kind: 'range', min: 0, max: base.max, step: base.step, default: 0, unit: base.unit,
      help: 'Mean of the exponential tail added on top of the floor.', activeWhen: distActive },
    { key: `${key}Sigma`, label: `${label}: sigma`, group, kind: 'range', min: 0, max: 2, step: 0.05, default: 0.5,
      help: 'Lognormal shape parameter (log-space std dev). Higher = heavier tail.', activeWhen: lognormalActive },
  ]
}

/** Draw a value for a param set up with `distParams`. */
export function sampleDist(rng: Rng, p: Params, key: string): number {
  const base = num(p, key)
  switch (str(p, `${key}Dist`)) {
    case 'shifted-exp': {
      const tail = num(p, `${key}Tail`)
      return tail > 0 ? base + rng.exp(1 / tail) : base
    }
    case 'lognormal': {
      const sigma = num(p, `${key}Sigma`)
      return sigma > 0 && base > 0 ? Math.exp(Math.log(base) + sigma * rng.normal()) : base
    }
    default:
      return base
  }
}
