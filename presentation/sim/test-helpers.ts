import type { InstanceOpts } from './instance'

/**
 * Convenience for tests that only care about "N concurrent slots, X sim-seconds
 * each" and don't need the CPU/IO pool model — maps that flat shape onto
 * a single-step plan with a same-sized, never-contended CPU pool, so the
 * resulting behavior matches the old flat `concurrency`/`serviceTime`
 * model exactly.
 */
export function flatOpts(o: {
  bootTime?: number | (() => number)
  serviceTime: () => number
  concurrency: number
  queueLimit: number
  hungCpu?: number
}): InstanceOpts {
  return {
    bootTime: o.bootTime ?? 0,
    workerPool: { slots: o.concurrency, queueLimit: o.queueLimit },
    cpuPool: { slots: o.concurrency },
    steps: () => [{ pool: 'cpu', scope: 'instance', duration: o.serviceTime() }],
    hungCpu: o.hungCpu,
  }
}
