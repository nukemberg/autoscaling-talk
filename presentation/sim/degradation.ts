// presentation/sim/degradation.ts

export type DegradationShape = 'none' | 'step' | 'logistic' | 'usl'

export interface StepDegradationOpts {
  /** Outstanding count above which the step multiplier applies. */
  threshold: number
  /** Multiplier applied once outstanding exceeds `threshold`. */
  maxFactor: number
}

export interface LogisticDegradationOpts {
  /** Outstanding count at the curve's midpoint (multiplier halfway between 1 and maxFactor). */
  center: number
  /** Controls how sharply the curve transitions around `center` — smaller is sharper. */
  width: number
  /** Multiplier approached as outstanding grows well past `center`. */
  maxFactor: number
}

export interface UslDegradationOpts {
  /** Contention (serialization/lock-wait) coefficient — linear penalty per unit of outstanding. */
  alpha: number
  /** Coherency (cache/GC/kernel cross-talk) coefficient — quadratic penalty, causes retrograde collapse. */
  beta: number
}

export type DegradationOpts =
  | { shape: 'none' }
  | ({ shape: 'step' } & StepDegradationOpts)
  | ({ shape: 'logistic' } & LogisticDegradationOpts)
  | ({ shape: 'usl' } & UslDegradationOpts)

/**
 * Builds a service-time multiplier as a function of an instance's own live outstanding
 * request count (in-flight + queued). The multiplier is always >= 1 — this models
 * self-inflicted slowdown under load, never a speedup.
 */
export function buildDegradation(opts: DegradationOpts): (outstanding: number) => number {
  switch (opts.shape) {
    case 'none':
      return () => 1
    case 'step': {
      const { threshold, maxFactor } = opts
      return (outstanding) => (outstanding > threshold ? maxFactor : 1)
    }
    case 'logistic': {
      const { center, width, maxFactor } = opts
      return (outstanding) => 1 + (maxFactor - 1) / (1 + Math.exp(-(outstanding - center) / width))
    }
    case 'usl': {
      const { alpha, beta } = opts
      return (outstanding) => Math.max(1, 1 + alpha * (outstanding - 1) + beta * outstanding * (outstanding - 1))
    }
  }
}
