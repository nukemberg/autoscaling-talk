import type { MetricSource } from '../controllers/metrics'
import type { Stats } from '../stats'

export interface MetricDef {
  id: string
  label: string
  unit: string
  /** 'utilization': chart gets a fixed [0,100]% scale; the CPU entry also drives the pre-run
   *  warmup sizing math (see unitCapacity/neededInstances in shared.ts). 'absolute': chart
   *  auto-ranges; warmup sizing always falls back to the CPU entry regardless (see spec §9). */
  kind: 'utilization' | 'absolute'
  source: MetricSource
  /** Sensible default target/threshold in this metric's own units, used to seed the param default
   *  when a scenario first turns this metric on. */
  defaultTarget: number
}

export const metricRegistry = {
  cpu: {
    id: 'cpu', label: 'CPU utilization', unit: '%', kind: 'utilization', defaultTarget: 0.5,
    source: { kind: 'counter', read: (inst) => inst.cpuSeconds },
  },
  worker: {
    id: 'worker', label: 'worker pool utilization', unit: '%', kind: 'utilization', defaultTarget: 0.7,
    source: { kind: 'gauge', read: (inst) => inst.utilization },
  },
  queue: {
    id: 'queue', label: 'queue depth', unit: 'reqs', kind: 'absolute', defaultTarget: 5,
    source: { kind: 'gauge', read: (inst) => inst.queued },
  },
  rps: {
    id: 'rps', label: 'requests/s per pod', unit: 'req/s', kind: 'absolute', defaultTarget: 50,
    source: { kind: 'counter', read: (inst) => inst.servedRequests },
  },
} satisfies Record<string, MetricDef>

/**
 * Latency isn't per-pod like the others — it's tracked cluster-wide (Stats, fed from the LB).
 * Modeled as a gauge that reports the SAME cluster-wide value for every instance asked, so it
 * fits the per-pod MetricSource shape without a second code path through Hpa/AwsPolicy — real
 * HPA's "External" metric type is exactly this shape (one cluster-wide value, not per-pod).
 */
export function latencyMetric(stats: Stats, windowSec: number): MetricDef {
  return {
    id: 'latency', label: 'mean latency (OK requests)', unit: 'ms', kind: 'absolute', defaultTarget: 200,
    // No OK completions in the window (e.g. a total outage) means the metric is unavailable, not
    // a healthy 0ms — reporting 0 would look great and could push a scale-down mid-outage.
    source: { kind: 'gauge', read: () => {
      const t = stats.latency(windowSec)
      return t.count ? t.mean * 1000 : undefined
    } },
  }
}
