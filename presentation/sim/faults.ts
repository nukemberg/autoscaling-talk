import type { Cluster } from './cluster'
import type { Sim } from './engine'
import type { Instance } from './instance'
import type { Upstream } from './upstream'

/** How many instances a fault touches: absolute or fraction of current size (min 1). */
interface Scope { count?: number; fraction?: number }

export type Fault =
  | ({ kind: 'kill'; at: number } & Scope)
  | ({ kind: 'hang'; at: number; duration: number } & Scope)
  | ({ kind: 'slow'; at: number; duration: number; factor: number } & Scope)
  | { kind: 'rollingRestart'; at: number; batch: number; interval: number }
  | { kind: 'upstreamOutage'; at: number; duration: number }
  | { kind: 'upstreamSlow'; at: number; duration: number; factor: number }

export interface FaultTargets {
  cluster: Cluster
  upstream?: Upstream
}

/** Oldest instances first: the ones that have been serving, not fresh boots. */
function pick(cluster: Cluster, scope: Scope): Instance[] {
  const n = scope.count ?? Math.max(1, Math.round(cluster.size * (scope.fraction ?? 0)))
  return cluster.instances.slice(0, n)
}

/** Schedule faults against the cluster / upstream. Times are absolute sim time. */
export function injectFaults(sim: Sim, targets: FaultTargets, faults: Fault[]): void {
  for (const f of faults) {
    if ((f.kind === 'upstreamOutage' || f.kind === 'upstreamSlow') && !targets.upstream) {
      throw new Error(`fault ${f.kind} needs an upstream`)
    }
    sim.scheduleAt(f.at, () => apply(sim, targets, f))
  }
}

function apply(sim: Sim, { cluster, upstream }: FaultTargets, f: Fault): void {
  switch (f.kind) {
    case 'kill':
      for (const i of pick(cluster, f)) cluster.crash(i)
      break
    case 'hang':
      for (const i of pick(cluster, f)) i.hang(f.duration)
      break
    case 'slow':
      for (const i of pick(cluster, f)) i.slow(f.factor, f.duration)
      break
    case 'rollingRestart': {
      const old = new Set(cluster.instances)
      const step = () => {
        const victims = cluster.instances.filter((i) => old.has(i)).slice(0, f.batch)
        if (!victims.length) return
        const target = cluster.size
        for (const v of victims) cluster.crash(v, false)
        cluster.scaleTo(target)            // relaunch immediately: a deploy, not a failure
        sim.schedule(f.interval, step)
      }
      step()
      break
    }
    case 'upstreamOutage':
      upstream!.outage(f.duration)
      break
    case 'upstreamSlow':
      upstream!.slow(f.factor, f.duration)
      break
  }
}
