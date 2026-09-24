# Multi-metric scaling Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give the autoscaling sim real multi-metric support — a small metric registry (cpu, worker utilization, queue depth, requests/s per pod, latency) read by both controller families through the existing `PodMetrics`/`MetricSource` abstraction, real HPA multi-metric behavior (per-metric desired, max wins), an AWS metric selector, and a runaway-latency demo scenario showing autoscaling fixing nothing when the bottleneck isn't capacity-shaped.

**Architecture:** One `PodMetrics` instance per active metric (not a multi-source `PodMetrics`). `Hpa` takes an array of `{ metrics: PodMetrics, target, id }` and takes the max desired count across them — the real k8s algorithm. AWS controllers are unchanged; `attachController` just picks one `PodMetrics` for them. Latency is modeled as a per-pod `MetricSource` that reports the same cluster-wide value for every pod, so it fits the registry without a second code path. A new shared cluster-scoped "db" pool (`Cluster.clusterPools`, already built, never wired to a scenario) gives the runaway demo an honest "scaling out adds no relief" mechanism.

**Tech Stack:** TypeScript, Vitest. No new dependencies.

**Spec:** `docs/superpowers/specs/2026-09-24-multi-metric-scaling-design.md` (read the whole thing — this plan argues from it and doesn't repeat every rationale).

## Global Constraints

- Use `vitest run` (via `presentation/package.json`'s `test` script): `cd presentation && npm test`. Target a single file with `npx vitest run <path>`.
- Keep the sim deterministic: no `Math.random()` — all randomness through the seeded `Rng`.
- `PodMetrics` itself does not change — multi-metric is one-instance-per-metric, not a multi-source scrape loop (spec Non-goals).
- `Instance.cpu`/`Instance.utilization`'s existing semantics and tests do not change — this plan only ADDS `servedRequests`.
- `controllers/aws.ts` does not change at all — AWS's "multi-metric support" is entirely at the `attachController` wiring layer (spec §5).
- Every new/changed public field needs a one-line doc comment, matching existing style.

---

## File Structure

- Modify `presentation/sim/instance.ts` — add `servedRequests` counter.
- Create `presentation/sim/scenarios/metricRegistry.ts` — the metric registry + `latencyMetric()` factory.
- Create `presentation/sim/scenarios/metricRegistry.test.ts`.
- Modify `presentation/sim/controllers/hpa.ts` — multi-metric `HpaOpts`/`sync()`.
- Modify `presentation/sim/controllers/hpa.test.ts` — new shape, new multi-metric test.
- Modify `presentation/sim/scenarios/shared.ts` — `dbPoolSlots`/`dbQueryMs` params, per-metric toggle+target params, `clusterOpts()`/`instanceOpts()` updates, `attachController()` rewrite (new `stats` param, metric wiring).
- Modify `presentation/sim/scenarios/shared.test.ts` — new params/wiring coverage.
- Modify `presentation/sim/scenarios/cpu.ts` — pass `stats` to `attachController`, replace the hand-rolled `cpuPct` probe with `controller.metric`, rename the `cpu` chart series to `metric`.
- Modify `presentation/sim/scenarios/cpu.test.ts` — update series-key assertions.
- Create `presentation/presets/latency-runaway.json` + slide in `presentation/slides.md`.
- Final cleanup + full verification pass.

---

### Task 1: `Instance.servedRequests`

**Files:**
- Modify: `presentation/sim/instance.ts` (the `finish()` method, ~line 274, and the class's private-field block near `hangCpuAdj`)
- Modify: `presentation/sim/instance.test.ts`

**Interfaces:**
- Produces: `Instance.servedRequests: number` (cumulative counter, incremented only on `'ok'` completions) — consumed by Task 2's `metricRegistry.ts` (`rps` entry: `read: (inst) => inst.servedRequests`).

- [ ] **Step 1: Write the failing test**

Add to `presentation/sim/instance.test.ts` (follow the existing `make()`/`req()` helpers already in that file):

```typescript
describe('Instance.servedRequests', () => {
  test('increments only on ok completions, not rejected/error', () => {
    const sim = new Sim()
    const { inst } = make(sim, { workerPool: { slots: 1 }, steps: () => [cpuStep(1)] })
    expect(inst.servedRequests).toBe(0)
    inst.handle(req(sim, 0))
    sim.run() // completes 'ok'
    expect(inst.servedRequests).toBe(1)
    inst.handle(req(sim, 1)) // fills the one worker slot
    inst.handle(req(sim, 2)) // no queue configured (default queueLimit 0) → rejected
    expect(inst.servedRequests).toBe(1) // the rejection didn't count
    sim.run()
    expect(inst.servedRequests).toBe(2) // the second request did complete 'ok'
  })
})
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd presentation && npx vitest run sim/instance.test.ts`
Expected: FAIL — `servedRequests` doesn't exist on `Instance`.

- [ ] **Step 3: Implement**

In `presentation/sim/instance.ts`, add a private field alongside the other counters (near `hangCpuAdj`):

```typescript
  /** Cumulative count of requests this instance finished with outcome 'ok' — a counter, like cpuSeconds. */
  private served = 0
```

Add the public getter next to `cpuSeconds`:

```typescript
  /** Cumulative served-request count, for a requests/s-per-pod metric — a monotone counter, rated the same way `cpuSeconds` is. */
  get servedRequests(): number { return this.served }
```

In `finish()`, increment on `'ok'`:

```typescript
  private finish(req: Request, outcome: Outcome): void {
    req.doneAt = this.sim.now
    req.outcome = outcome
    if (outcome === 'ok') this.served++
    this.onDone(req)
  }
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `cd presentation && npx vitest run sim/instance.test.ts`
Expected: PASS (all tests, including the new one).

- [ ] **Step 5: Commit**

```bash
cd presentation && git add sim/instance.ts sim/instance.test.ts
git commit -m "$(cat <<'EOF'
Add Instance.servedRequests counter

A monotone counter of 'ok' completions, rated the same way cpuSeconds
already is — feeds a requests/s-per-pod scaling metric.

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>
EOF
)"
```

---

### Task 2: metric registry

**Files:**
- Create: `presentation/sim/scenarios/metricRegistry.ts`
- Create: `presentation/sim/scenarios/metricRegistry.test.ts`

**Interfaces:**
- Consumes: `Instance.cpuSeconds`/`utilization`/`queued`/`servedRequests` (already exist; `servedRequests` from Task 1), `MetricSource` from `../controllers/metrics`, `Stats` from `../stats`.
- Produces: `MetricDef` interface, `metricRegistry: Record<'cpu' | 'worker' | 'queue' | 'rps', MetricDef>`, `latencyMetric(stats: Stats, windowSec: number): MetricDef` — consumed by Task 4's `attachController` rewrite.

- [ ] **Step 1: Write the failing tests**

```typescript
// presentation/sim/scenarios/metricRegistry.test.ts
import { describe, expect, test } from 'vitest'
import { Cluster } from '../cluster'
import { Sim } from '../engine'
import { LoadBalancer } from '../lb'
import { Stats } from '../stats'
import { flatOpts } from '../test-helpers'
import { latencyMetric, metricRegistry } from './metricRegistry'

function setup(sim: Sim) {
  const lb = new LoadBalancer(sim)
  const cluster = new Cluster(sim, lb, flatOpts({ bootTime: 0, serviceTime: () => 1, concurrency: 4, queueLimit: 0 }))
  cluster.scaleTo(1)
  return cluster.instances[0]!
}

describe('metricRegistry', () => {
  test('cpu reads inst.cpuSeconds as a counter', () => {
    expect(metricRegistry.cpu.source.kind).toBe('counter')
    const sim = new Sim()
    const inst = setup(sim)
    expect(metricRegistry.cpu.source.read(inst)).toBe(inst.cpuSeconds)
  })

  test('worker reads inst.utilization as a gauge', () => {
    expect(metricRegistry.worker.source.kind).toBe('gauge')
    const sim = new Sim()
    const inst = setup(sim)
    inst.handle({ id: 0, arrivedAt: 0 })
    expect(metricRegistry.worker.source.read(inst)).toBe(inst.utilization)
  })

  test('queue reads inst.queued as a gauge', () => {
    expect(metricRegistry.queue.source.kind).toBe('gauge')
    const sim = new Sim()
    const inst = setup(sim)
    expect(metricRegistry.queue.source.read(inst)).toBe(inst.queued)
  })

  test('rps reads inst.servedRequests as a counter', () => {
    expect(metricRegistry.rps.source.kind).toBe('counter')
    const sim = new Sim()
    const inst = setup(sim)
    expect(metricRegistry.rps.source.read(inst)).toBe(inst.servedRequests)
  })

  test('every registry entry has a positive defaultTarget and a kind', () => {
    for (const def of Object.values(metricRegistry)) {
      expect(def.defaultTarget).toBeGreaterThan(0)
      expect(['utilization', 'absolute']).toContain(def.kind)
    }
  })
})

describe('latencyMetric', () => {
  test('reports the same cluster-wide value regardless of which instance is asked', () => {
    const sim = new Sim()
    const stats = new Stats(sim)
    stats.record({ id: 0, arrivedAt: 0, doneAt: 0.25, outcome: 'ok' }) // 250ms
    const a = setup(sim)
    const b = setup(new Sim()) // a different Instance entirely
    const m = latencyMetric(stats, 60)
    expect(m.source.kind).toBe('gauge')
    const va = m.source.read(a)
    const vb = m.source.read(b)
    expect(va).toBe(vb) // the whole point: degenerate per-pod, same value everywhere
    expect(va).toBeCloseTo(250, 0)
  })

  test('reports 0 when there is no recent data, not NaN', () => {
    const sim = new Sim()
    const stats = new Stats(sim)
    const inst = setup(sim)
    expect(latencyMetric(stats, 60).source.read(inst)).toBe(0)
  })
})
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `cd presentation && npx vitest run sim/scenarios/metricRegistry.test.ts`
Expected: FAIL — the module doesn't exist yet.

- [ ] **Step 3: Implement**

```typescript
// presentation/sim/scenarios/metricRegistry.ts
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
    source: { kind: 'gauge', read: () => (stats.latency(windowSec).mean || 0) * 1000 },
  }
}
```

Note: `Tally.mean` (what `stats.latency(window)` returns) is `NaN` when there are no samples (per `presentation/sim/metrics.ts`'s `Tally.mean` getter) — `stats.latency(windowSec).mean || 0` turns that `NaN` into `0` (NaN is falsy), matching the "reports 0 when there is no recent data" test above. Verify this against the actual `Tally` implementation before relying on it — if `mean` returns something other than `NaN` for an empty tally, adjust the guard accordingly (e.g. `Number.isNaN(...) ? 0 : ...`).

- [ ] **Step 4: Run the tests to verify they pass**

Run: `cd presentation && npx vitest run sim/scenarios/metricRegistry.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
cd presentation && git add sim/scenarios/metricRegistry.ts sim/scenarios/metricRegistry.test.ts
git commit -m "$(cat <<'EOF'
Add metric registry: cpu, worker, queue, rps, latency

Static per-pod metric definitions over the existing PodMetrics/
MetricSource abstraction, plus latencyMetric() modeling the
cluster-wide Stats.latency() as a degenerate per-pod source (same
value reported for every instance) so it fits the same shape.

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>
EOF
)"
```

---

### Task 3: shared DB pool (`dbPoolSlots`/`dbQueryMs`)

**Files:**
- Modify: `presentation/sim/scenarios/shared.ts` (`unitParams`, `clusterOpts()`, `instanceOpts()`)
- Modify: `presentation/sim/scenarios/shared.test.ts`

**Interfaces:**
- Consumes: `Cluster`'s existing `ClusterOpts.clusterPools` (already implemented, unchanged), `Step`/`InstanceOpts` from `../instance` (unchanged shape).
- Produces: two new `unitParams` entries; `clusterOpts(p)` and `instanceOpts(p, rng)` both read `dbPoolSlots`/`dbQueryMs`. No new exports — same function signatures as today.

- [ ] **Step 1: Write the failing tests**

Add to `presentation/sim/scenarios/shared.test.ts`:

```typescript
describe('shared DB pool (dbPoolSlots)', () => {
  test('dbPoolSlots 0 (default): clusterOpts has no clusterPools, instanceOpts has a 2-step plan', () => {
    const o = clusterOpts({ ...base, dbPoolSlots: 0 })
    expect(o.clusterPools).toBeUndefined()
    const io = instanceOpts({ ...base, dbPoolSlots: 0 }, new Rng(1))
    expect(io.steps!().map((s) => s.pool)).toEqual(['io', 'cpu'])
  })

  test('dbPoolSlots > 0: clusterOpts defines a db pool, instanceOpts inserts a cluster-scoped db step', () => {
    const o = clusterOpts({ ...base, dbPoolSlots: 5 })
    expect(o.clusterPools).toEqual({ db: { slots: 5, queueLimit: 1000 } })
    const io = instanceOpts({ ...base, dbPoolSlots: 5, dbQueryMs: 30 }, new Rng(1))
    const steps = io.steps!()
    expect(steps.map((s) => [s.pool, s.scope])).toEqual([['io', 'instance'], ['db', 'cluster'], ['cpu', 'instance']])
    expect(steps[1]!.duration).toBeCloseTo(0.03) // 30ms -> seconds
  })
})
```

Check the exact current signature of `base` in `shared.test.ts` (it's built via `defaults(unitParams)` or similar spread of `unitParams`/`scalerParams` — match whatever pattern the file already uses so `base.dbPoolSlots` picks up the new param's default via the same mechanism the other params use).

- [ ] **Step 2: Run the tests to verify they fail**

Run: `cd presentation && npx vitest run sim/scenarios/shared.test.ts`
Expected: FAIL — `dbPoolSlots`/`dbQueryMs` aren't params yet.

- [ ] **Step 3: Implement**

In `presentation/sim/scenarios/shared.ts`, add to `unitParams` (after `poisonProb`, before the `bootSec` dist params — anywhere in the `unit` group works, this placement keeps it near the other per-request work-shape knobs):

```typescript
  { key: 'dbPoolSlots', label: 'shared DB pool slots', group: 'unit', kind: 'range', min: 0, max: 50, step: 1, default: 0,
    help: 'Shared DB connection pool across the WHOLE cluster. 0 = disabled (no shared bottleneck). >0 = every request also needs one of these shared slots — unlike cores/workers, scaling out instances does NOT scale this. The classic "autoscaled app exhausts DB connections" failure.' },
  { key: 'dbQueryMs', label: 'DB query time', group: 'unit', kind: 'range', min: 1, max: 500, step: 1, default: 20, unit: 'ms',
    help: 'How long a request holds a DB connection slot. Only matters when shared DB pool slots > 0.' },
```

Update `clusterOpts()`:

```typescript
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
```

Update `instanceOpts()`'s `steps` closure (currently a fixed 2-element array literal — becomes a small function body):

```typescript
    steps: () => {
      const dbSlots = num(p, 'dbPoolSlots')
      const plan: Step[] = [{ pool: 'io', scope: 'instance', duration: sampleDist(rng, p, 'ioWaitMs') / 1000 }]
      if (dbSlots > 0) plan.push({ pool: 'db', scope: 'cluster', duration: num(p, 'dbQueryMs') / 1000 })
      plan.push({ pool: 'cpu', scope: 'instance', duration: sampleDist(rng, p, 'cpuTimeMs') / 1000 })
      return plan
    },
```

You'll need `import type { InstanceOpts, Step } from '../instance'` — check the current import line at the top of `shared.ts` and add `Step` to it if it isn't already imported.

- [ ] **Step 4: Run the tests to verify they pass**

Run: `cd presentation && npx vitest run sim/scenarios/shared.test.ts`
Expected: PASS.

- [ ] **Step 5: Run the full suite to catch collateral effects**

Run: `cd presentation && npm test`
Expected: PASS. `dbPoolSlots` defaults to 0, so every existing scenario/preset is unaffected (no `db` step, no `clusterPools`) — if anything fails, it's almost certainly an unrelated pre-existing issue or a `Params` object somewhere that doesn't go through `defaults(unitParams)` and needs the new keys added explicitly; investigate rather than assume.

- [ ] **Step 6: Commit**

```bash
cd presentation && git add sim/scenarios/shared.ts sim/scenarios/shared.test.ts
git commit -m "$(cat <<'EOF'
Wire a shared DB connection pool (dbPoolSlots/dbQueryMs)

Uses Cluster's existing clusterPools mechanism (built earlier, never
wired to a scenario): a fixed-size pool shared across the whole
cluster, so scaling out instances adds contention, not capacity.
Disabled by default (0 slots) — zero effect on any existing scenario.

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>
EOF
)"
```

---

### Task 4: HPA multi-metric rewrite

**Files:**
- Modify: `presentation/sim/controllers/hpa.ts`
- Modify: `presentation/sim/controllers/hpa.test.ts`

**Interfaces:**
- Produces: `HpaOpts.metrics: { metrics: PodMetrics; target: number; id: string }[]` (replaces the old standalone `metrics: PodMetrics` constructor param + `target: number` opt), `Hpa.metric` now reports whichever metric's computation produced the max desired count.
- Consumed by: Task 5's `attachController` rewrite.

- [ ] **Step 1: Update the tests first**

Read the CURRENT `presentation/sim/controllers/hpa.test.ts` in full before editing — it has a `setup()` helper building `new Hpa(sim, cluster, metrics, { target: 0.5, min: 1, max: 100, ...over })`. Every call site needs updating to the new shape: `new Hpa(sim, cluster, { min: 1, max: 100, metrics: [{ metrics, target: 0.5, id: 'test' }], ...over })`. This is mechanical across all ~9 existing tests in that file — update `setup()`'s `Hpa` construction once; the individual tests call `setup()` so they shouldn't need per-test changes unless they pass `target` directly in `over` (check for that pattern and adapt: `over` entries like `{ target: 0.05 }` become `{ metrics: [{ metrics, target: 0.05, id: 'test' }] }` — you'll need to restructure `setup()`'s signature slightly so callers can still override just the target without repeating the whole `metrics` array; use your judgment on the cleanest way to do this, e.g. `setup(sim, ready, { target, ...over } = {})` building the `metrics` array internally from `target`).

Add one new test proving real multi-metric behavior:

```typescript
test('multi-metric: the metric wanting more replicas wins, and .metric reports its value', () => {
  const sim = new Sim()
  const lb = new LoadBalancer(sim)
  let launches = 0
  const cluster = new Cluster(sim, lb, flatOpts({
    bootTime: () => (launches++ < 4 ? 0 : 1000), serviceTime: () => 1, concurrency: 10, queueLimit: 0,
  }))
  cluster.scaleTo(4)
  const cpuLevel = new Map<Instance, number>()
  let cpuAll = 0.6 // wants ceil(4 * 0.6/0.5) = 5
  const rpsAll = 40  // target 100, way under target -> wants LESS, shouldn't win the max
  const cpuMetrics = new PodMetrics(sim, cluster, { sampleInterval: 5, source: { kind: 'gauge', read: () => cpuAll } })
  const rpsMetrics = new PodMetrics(sim, cluster, { sampleInterval: 5, source: { kind: 'gauge', read: () => rpsAll } })
  sim.run(60)
  cpuMetrics.start()
  rpsMetrics.start()
  const hpa = new Hpa(sim, cluster, {
    min: 1, max: 100,
    metrics: [{ metrics: cpuMetrics, target: 0.5, id: 'cpu' }, { metrics: rpsMetrics, target: 100, id: 'rps' }],
  })
  sim.run(sim.now + 15)
  hpa.start()
  sim.run(sim.now + 15)
  expect(cluster.size).toBe(5)     // cpu's recommendation won
  expect(hpa.metric).toBeCloseTo(0.6) // .metric reflects the DRIVING metric (cpu), not rps
})
```

Check the imports this new test needs (`Cluster`, `Sim`, `LoadBalancer`, `PodMetrics`, `flatOpts`, `Instance` type) against what's already imported at the top of `hpa.test.ts` and add whatever's missing.

- [ ] **Step 2: Run the tests to verify they fail**

Run: `cd presentation && npx vitest run sim/controllers/hpa.test.ts`
Expected: FAIL — `HpaOpts`/`Hpa` constructor don't match the new shape yet.

- [ ] **Step 3: Implement**

Replace `presentation/sim/controllers/hpa.ts`'s `HpaOpts` interface, constructor, and `sync()` method. Read the CURRENT file in full first (it's short, ~137 lines) — `recommend()` and `replicasAt()` are UNCHANGED, only `HpaOpts`, the constructor signature, and `sync()` change:

```typescript
export interface HpaMetric {
  metrics: PodMetrics
  target: number
  /** For diagnostics/tests only — not used in the scaling math itself. */
  id: string
}

export interface HpaOpts {
  metrics: HpaMetric[]
  min: number
  max: number
  syncPeriod?: number
  tolerance?: number
  initialReadinessDelay?: number
  downStabilization?: number
  scaleUpPods?: number
  scaleUpPercent?: number
  scaleUpPeriod?: number
  scaleDownPercent?: number
  scaleDownPeriod?: number
}
```

```typescript
  constructor(private sim: Sim, private cluster: Cluster, private opts: HpaOpts) {}
```

(Drop the old standalone `metrics: PodMetrics` constructor parameter entirely — it's now `opts.metrics`.)

```typescript
  private sync(): void {
    this.sim.schedule(this.o.syncPeriod, () => this.sync())
    const pods = this.cluster.instances.filter((i) => i.state !== 'terminated')
    const current = pods.length
    if (!current) return

    let best: { desired: number; metric: number } | undefined
    for (const m of this.opts.metrics) {
      const r = this.desiredForMetric(m, pods, current)
      if (r && (!best || r.desired > best.desired)) best = r
    }
    if (!best) return // no toggled metric had data from any pod this tick

    this.metric = best.metric
    this.recommend(best.desired)
  }

  /** One metric's contribution to the multi-metric max — real HPA computes desired PER
   *  metric (including its own set-aside/tolerance handling) and takes the largest. Returns
   *  undefined when this metric had no data from any pod this tick (real HPA skips a metric
   *  it can't retrieve rather than failing the whole sync). */
  private desiredForMetric(m: HpaMetric, pods: readonly Instance[], current: number): { desired: number; metric: number } | undefined {
    const o = this.o
    const now = this.sim.now
    const withMetric: number[] = []
    let setAside = 0
    for (const p of pods) {
      const notYetReady = p.state !== 'ready' || (p.readySince ?? now) > now - o.initialReadinessDelay
      const v = notYetReady ? undefined : m.metrics.latest(p)
      if (v === undefined) setAside++
      else withMetric.push(v)
    }
    if (!withMetric.length) return undefined

    const avg = withMetric.reduce((a, b) => a + b, 0) / withMetric.length
    const ratio = avg / m.target
    if (Math.abs(ratio - 1) <= o.tolerance) return { desired: current, metric: avg }

    let desired: number
    if (ratio > 1) {
      const newRatio = (avg * withMetric.length) / (m.target * current)
      if (Math.abs(newRatio - 1) <= o.tolerance || newRatio < 1) return { desired: current, metric: avg }
      desired = Math.ceil(current * newRatio)
    } else {
      const newRatio = (avg * withMetric.length + m.target * setAside) / (m.target * current)
      if (Math.abs(newRatio - 1) <= o.tolerance || newRatio > 1) return { desired: current, metric: avg }
      desired = Math.ceil(current * newRatio)
    }
    return { desired: Math.min(this.opts.max, Math.max(this.opts.min, desired)), metric: avg }
  }
```

Note this needs `Instance` imported as a type: `import type { Instance } from '../instance'` (check whether it's already imported in `hpa.ts` — it currently isn't, since `pods`/`p` were untyped-inferred from `this.cluster.instances`; you may need to add this import, or keep `pods: readonly Instance[]` inferred without an explicit type annotation if that's simpler — your call, whichever typechecks cleanly).

`recommend(rec: number)` and `replicasAt(t: number)` at the bottom of the file: leave completely unchanged, they already just take a single `rec: number`.

- [ ] **Step 4: Run the tests to verify they pass**

Run: `cd presentation && npx vitest run sim/controllers/hpa.test.ts`
Expected: PASS (all existing tests migrated + the new multi-metric test).

- [ ] **Step 5: Typecheck**

Run: `cd presentation && npx tsc --noEmit -p sim/tsconfig.json`
Expected: no errors. (`shared.ts`'s `attachController` still constructs `Hpa` with the OLD shape at this point in the plan — Task 5 fixes that. If this typecheck fails ONLY because of `shared.ts`'s now-stale `Hpa` call site, that's expected and fine to leave for Task 5; if it fails for any OTHER reason, fix it now.)

- [ ] **Step 6: Commit**

```bash
cd presentation && git add sim/controllers/hpa.ts sim/controllers/hpa.test.ts
git commit -m "$(cat <<'EOF'
Hpa: real multi-metric support (per-metric desired, max wins)

HpaOpts.metrics replaces the single target/metrics-instance shape.
sync() computes each toggled metric's desired replica count
independently (same set-aside/tolerance handling as before, now
per-metric) and takes the max — the real k8s HPA algorithm.
recommend()/replicasAt() (stabilization, rate limits) are unchanged,
since they already operate on a single recommended count regardless
of how many metrics fed into it.

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>
EOF
)"
```

---

### Task 5: param surface + `attachController` wiring

**Files:**
- Modify: `presentation/sim/scenarios/shared.ts` (`scalerParams`, `attachController()`, `targetUtilization()`)
- Modify: `presentation/sim/scenarios/shared.test.ts`

**Interfaces:**
- Consumes: `metricRegistry`/`latencyMetric` (Task 2), `HpaOpts.metrics` shape (Task 4).
- Produces: `attachController(sim, cluster, p, stats)` — signature GROWS a required `stats: Stats` parameter (breaking change to this function's one call site, fixed in Task 6). New `scalerParams` entries: `metricCpu`/`metricCpuTarget`, `metricWorker`/`metricWorkerTarget`, `metricQueue`/`metricQueueTarget`, `metricRps`/`metricRpsTarget`, `metricLatency`/`metricLatencyTarget`. Removes `hpaTarget` and `awsTarget` is repurposed (see below).

- [ ] **Step 1: Write the failing tests**

Add to `presentation/sim/scenarios/shared.test.ts` (read the file's existing imports/`Stats` usage patterns first — you'll need `new Stats(sim)` and a `Cluster`/`LoadBalancer` to call `attachController` at all, similar to how `cpu.ts`'s `run()` sets these up):

```typescript
import { Cluster } from '../cluster'
import { LoadBalancer } from '../lb'
import { Stats } from '../stats'
// (add whichever of these aren't already imported in this file)

describe('attachController: multi-metric wiring', () => {
  function setup(sim: Sim, overrides: Partial<Params> = {}) {
    const p = { ...base, ...defaults(scalerParams), ...overrides }
    const lb = new LoadBalancer(sim, lbOpts(p))
    const cluster = new Cluster(sim, lb, instanceOpts(p, new Rng(1)), clusterOpts(p))
    cluster.scaleTo(2)
    const stats = new Stats(sim)
    return { p, cluster, stats }
  }

  test('default (only metricCpu on): Hpa gets exactly one metric', () => {
    const sim = new Sim()
    const { p, cluster, stats } = setup(sim)
    const c = attachController(sim, cluster, p, stats) as unknown as { opts: { metrics: unknown[] } }
    // If Hpa's `metrics` internal isn't reachable this way, adjust: assert via observable
    // behavior instead (e.g. that `c` behaves like today's single-CPU-metric HPA) — whichever
    // is more robust given Hpa's actual field visibility; don't force a private-field reach-in
    // if TypeScript won't allow it without a cast that feels fragile.
  })

  test('multiple metrics toggled on: Hpa receives all of them', () => {
    const sim = new Sim()
    const { p, cluster, stats } = setup(sim, { metricCpu: true, metricRps: true })
    attachController(sim, cluster, p, stats)
    // Assert observable behavior: this is exercised more thoroughly in cpu.test.ts's
    // integration-level tests (Task 6) — a lighter existence/no-throw check is enough here.
  })

  test('nothing toggled on: falls back to CPU only rather than erroring', () => {
    const sim = new Sim()
    const { p, cluster, stats } = setup(sim, { metricCpu: false })
    expect(() => attachController(sim, cluster, p, stats)).not.toThrow()
  })

  test('AWS algo: uses whichever single metric is toggled (first one, if several)', () => {
    const sim = new Sim()
    const { p, cluster, stats } = setup(sim, { algo: 'aws-target', metricCpu: false, metricRps: true })
    expect(() => attachController(sim, cluster, p, stats)).not.toThrow()
  })
})
```

The first test's private-field reach-in is deliberately left loose — **before implementing**, look at what `Hpa`/`Controller` actually expose publicly and write an assertion against real observable behavior (e.g. run the sim forward with a known metric level and check `cluster.size` responds, similar to `hpa.test.ts`'s own tests) rather than reaching into internals. Replace that test's body with something concrete once you can see what's actually checkable — don't leave a no-op test in the final commit.

- [ ] **Step 2: Run the tests to verify they fail**

Run: `cd presentation && npx vitest run sim/scenarios/shared.test.ts`
Expected: FAIL — `attachController` doesn't take a 4th `stats` argument yet, `metricCpu` etc. aren't params yet.

- [ ] **Step 3: Implement**

In `presentation/sim/scenarios/shared.ts`:

1. Add the import: `import { metricRegistry, latencyMetric } from './metricRegistry'` and `import { Stats } from '../stats'` and `import { PodMetrics } from '../controllers/metrics'` (check which of these are already imported — `PodMetrics` should already be there).

2. Replace the `hpaTarget` param and `awsTarget` param in `scalerParams` with the per-metric toggle+target set (insert where `hpaTarget` currently is):

```typescript
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
  { key: 'metricQueueTarget', label: 'queue target', group: 'scaler', kind: 'range', min: 0, max: 50, step: 1, default: 5,
    help: 'Target queue depth per pod.', activeWhen: { metricQueue: 'true' } },
  { key: 'metricRps', label: 'requests/s per pod', group: 'scaler', kind: 'toggle', default: false,
    help: 'Scale on mean served requests/s per pod — a throughput target instead of a utilization one.' },
  { key: 'metricRpsTarget', label: 'rps target', group: 'scaler', kind: 'range', min: 1, max: 500, step: 1, default: 50,
    help: 'Target requests/s per pod.', activeWhen: { metricRps: 'true' } },
  { key: 'metricLatency', label: 'latency (mean, OK)', group: 'scaler', kind: 'toggle', default: false,
    help: 'Scale on mean end-to-end latency, cluster-wide — NOT a capacity signal; the same value is reported for every pod. See the runaway-latency demo for why this is a trap.' },
  { key: 'metricLatencyTarget', label: 'latency target (ms)', group: 'scaler', kind: 'range', min: 10, max: 2000, step: 10, default: 200,
    help: 'Target mean latency in ms.', activeWhen: { metricLatency: 'true' } },
```

Leave `awsOutThreshold`/`awsInThreshold`/`awsTarget` etc. exactly as they are — they're already generic "a number to compare the selected metric against," nothing about their own definitions needs to change; only WHICH metric they're compared against changes, at the wiring layer below.

3. Add a small helper (near `attachController`, or inline within it) mapping the five toggle keys to registry entries:

```typescript
const METRIC_IDS = ['cpu', 'worker', 'queue', 'rps', 'latency'] as const
type MetricId = typeof METRIC_IDS[number]
const METRIC_PARAM: Record<MetricId, { toggle: string; target: string }> = {
  cpu: { toggle: 'metricCpu', target: 'metricCpuTarget' },
  worker: { toggle: 'metricWorker', target: 'metricWorkerTarget' },
  queue: { toggle: 'metricQueue', target: 'metricQueueTarget' },
  rps: { toggle: 'metricRps', target: 'metricRpsTarget' },
  latency: { toggle: 'metricLatency', target: 'metricLatencyTarget' },
}
```

4. Rewrite `attachController`:

```typescript
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
        metrics: ids.map((id) => ({ metrics: podMetricsFor(id), target: num(p, METRIC_PARAM[id].target), id })),
        tolerance: num(p, 'hpaTolerance'), syncPeriod: num(p, 'hpaSyncSec'),
        initialReadinessDelay: num(p, 'hpaReadinessDelaySec'),
        downStabilization: num(p, 'hpaDownStabilizationSec'),
        scaleUpPods: num(p, 'hpaScaleUpPods'), scaleUpPercent: num(p, 'hpaScaleUpPercent'),
      })
  }
  c.start()
  return c
}
```

Note the OLD `const metrics = new PodMetrics(...); metrics.start()` two lines at the top of the old `attachController` are GONE — every branch now builds its own `PodMetrics` instance(s) via `podMetricsFor`.

5. Update `targetUtilization(p)` — per spec §9, this feeds ONLY the pre-run warmup sizing math and should keep reading CPU-shaped semantics specifically:

```typescript
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
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `cd presentation && npx vitest run sim/scenarios/shared.test.ts`
Expected: PASS. Replace the first test's placeholder body (per Step 1's note) with a real assertion before considering this done.

- [ ] **Step 5: Typecheck**

Run: `cd presentation && npx tsc --noEmit -p sim/tsconfig.json`
Expected: errors ONLY in `cpu.ts` (still calling `attachController` with 3 args) — that's Task 6. Anything else, fix now.

- [ ] **Step 6: Commit**

```bash
cd presentation && git add sim/scenarios/shared.ts sim/scenarios/shared.test.ts
git commit -m "$(cat <<'EOF'
Wire per-metric toggle+target params into attachController

Five toggleable metrics (cpu default-on, worker/queue/rps/latency
default-off), each with its own target param. HPA gets every toggled
metric (real multi-metric support via Task 4's Hpa rewrite); AWS gets
whichever one is toggled first (real CloudWatch alarms are
single-metric). Falls back to CPU-only if nothing is toggled.
attachController now takes the scenario's Stats (needed for the
latency metric). targetUtilization() stays CPU-shaped deliberately
(spec §9) — it only feeds pre-run warmup sizing.

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>
EOF
)"
```

---

### Task 6: `cpu.ts` wiring + chart rename

**Files:**
- Modify: `presentation/sim/scenarios/cpu.ts`
- Modify: `presentation/sim/scenarios/cpu.test.ts`

**Interfaces:**
- Consumes: `attachController(sim, cluster, p, stats)` (Task 5's new signature), `Controller.metric` (unchanged interface, `attachController`'s return already has this).
- Produces: chart series key `metric` (renamed from `cpu`) on `cpuScenario`'s first chart.

- [ ] **Step 1: Update the test first**

Read `presentation/sim/scenarios/cpu.test.ts` in full. Every place it references `r.series.cpu` (or similar) needs to become `r.series.metric`. This is likely just the `charts` iteration in the "returns aligned series for every charted key" test (which iterates `cpuScenario.charts` generically and shouldn't need a literal key change) plus any test that specifically asserts on CPU values by name — grep for `.cpu` in this test file and update each hit to `.metric`.

- [ ] **Step 2: Run to verify it fails**

Run: `cd presentation && npx vitest run sim/scenarios/cpu.test.ts`
Expected: FAIL (compile error or missing-key assertion) until `cpu.ts` itself is updated.

- [ ] **Step 3: Implement**

In `presentation/sim/scenarios/cpu.ts`:

1. Chart series: change the `key: 'cpu'` entry (in the first chart's `series` array) to `key: 'metric'`, and generalize its label since it's no longer always CPU:

```typescript
        { key: 'metric', label: 'scaling metric', color: 'cpu', width: 1.5, scale: 'pct' },
```

Keep the `scales: { pct: { range: [0, 100], ... } }` block as-is — per spec §8, utilization-kind metrics are ×100'd onto this same fixed scale, absolute-kind metrics are plotted unconverted on it (the axis is honestly relabeled, not auto-ranged — see spec §8 for why this is an acceptable simplification here).

2. In `run()`: `attachController(sim, cluster, p)` → `attachController(sim, cluster, p, stats)` (the `stats` object is already constructed earlier in this function — just thread it through).

3. Delete the entire `cpuPct`/`lastCpuSeconds` block (the hand-rolled per-window CPU-rate probe) — it's now redundant with `controller.metric`. Capture the controller's return value (`attachController` already returns a `Controller`, currently discarded) and use it directly:

```typescript
    const controller = attachController(sim, cluster, p, stats)
```

Replace the `Recorder`'s `cpu: cpuPct` probe with:

```typescript
      metric: () => controller.metric,
```

(If `controller.metric` reads `NaN` before the controller's first sync tick — check `Hpa`/`AwsPolicy`'s `metric` field's initial value, both currently default to `NaN` per their class field declarations — that's fine for a chart line and matches how e.g. `Hpa.metric = NaN` already behaves today before the first sync in the old single-metric code path; no special-casing needed unless a test fails because of it.)

4. Any leftover unused imports (`Instance` type, if it was only used by the deleted `cpuPct` block) — remove them; check with the typecheck in Step 5.

- [ ] **Step 4: Run the tests to verify they pass**

Run: `cd presentation && npx vitest run sim/scenarios/cpu.test.ts`
Expected: PASS.

- [ ] **Step 5: Typecheck + full suite**

Run: `cd presentation && npx tsc --noEmit -p sim/tsconfig.json && npm test`
Expected: both clean. This is the point where the WHOLE chain (Tasks 1-6) should compile and pass together — if anything outside `cpu.ts`/`cpu.test.ts` breaks, investigate rather than patching around it (likely a preset or another scenario file also calling `attachController` — check `rg -n "attachController" presentation/sim` for any other call sites this plan didn't anticipate).

- [ ] **Step 6: Commit**

```bash
cd presentation && git add sim/scenarios/cpu.ts sim/scenarios/cpu.test.ts
git commit -m "$(cat <<'EOF'
cpu.ts: chart the controller's own metric, not a hand-rolled CPU probe

Renames the 'cpu' chart series to 'metric' and reads it straight from
controller.metric — which already computes exactly this, per whichever
metric(s) are actually toggled on — instead of a parallel cpuSeconds-
rate calculation that only ever showed CPU regardless of what the
controller was actually scaling on.

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>
EOF
)"
```

---

### Task 7: `dbs` — the runaway-latency preset + slide

**Files:**
- Create: `presentation/presets/latency-runaway.json`
- Modify: `presentation/slides.md` (new slide, following the existing `unit-model-compare`/`cpu-oscillation` pattern — read one of those slides plus its preset first, in full, before writing this one, so the new content matches house style)

**Interfaces:**
- Consumes: `metricLatency`/`metricLatencyTarget` (Task 5), `dbPoolSlots`/`dbQueryMs` (Task 3) — no code changes, pure content/configuration.

This task is empirical — get the numbers right by actually running the scenario, the same way earlier work in this codebase's history built its demo presets (measure, don't guess).

- [ ] **Step 1: Read house style**

Read `presentation/presets/unit-model-compare.json` and its corresponding slide in `presentation/slides.md` in full (search for `unit-model-compare` to find the slide). Match this preset's JSON shape (`id`, `name`, `params`, `notes`) and the slide's shape (`# Title`, `<Sim preset="..." :expose="[...]" :height="130" />`, an HTML-comment presenter-notes block below it).

- [ ] **Step 2: Design the scenario**

Base it on `cpuScenario` (`id: "cpu-step"`, same as the other presets). Turn on `metricLatency` (and turn `metricCpu` off, so latency alone drives scaling — the whole point is showing what happens when ONLY latency is watched). Turn on the shared DB pool (`dbPoolSlots` > 0, small — e.g. 5-10) with a `dbQueryMs` large enough that DB contention, not CPU, dominates end-to-end latency once load rises. Pick a load ramp (reuse the existing `cpu-step`-style params: `baseRps`/`rps`/`ramp`/`quietSec`) that pushes past what the DB pool can sustain.

Write a throwaway measurement script (same pattern used elsewhere in this codebase's history for tuning demo presets — `import { cpuScenario } from '../sim/scenarios/cpu'`, build params via `resolvePreset`, call `.run()`, inspect `.summary` and the `instances`/`metric` series) to find parameter values where: (a) instance count climbs a lot (ideally toward `maxInstances`, or at least a clearly runaway-looking multiple of what CPU-based sizing would need), and (b) latency never meaningfully recovers despite that — the demo's entire point. Iterate on `dbPoolSlots`/`dbQueryMs`/load level until you get a clean version of this shape. Delete the throwaway script before committing (don't commit it).

- [ ] **Step 3: Write the preset**

`presentation/presets/latency-runaway.json` — `id: "cpu-step"`, `name: "latency-runaway"`, `params` with your tuned values, and a `notes` field written in the same reflective, numbers-backed style as `unit-model-compare.json`'s (state what you measured: peak/final instance count, the latency before/during/after, and the one-sentence lesson — scaling on latency added N× the instances and the latency barely moved, because the bottleneck was the shared DB pool, which more instances can't touch).

- [ ] **Step 4: Write the slide**

Add a new slide to `presentation/slides.md`, placed after the existing `unit-model-compare` slide (search for that slide's `---` boundary and insert the new one right after it, so the two "what does the wrong metric/wrong knob get you" demos sit together). Title something like `# Scaling on Latency: The Trap`. `<Sim preset="latency-runaway" :expose="['metricLatencyTarget', 'dbPoolSlots', 'dbQueryMs']" :height="130" />`. Presenter notes (HTML comment): explain live what the audience is watching — instance count climbing, latency not responding — and land the lesson explicitly (autoscaling can't fix a problem that isn't a capacity problem; a bigger fleet hammering the same fixed DB pool harder is not relief, it's the same queueing problem with a bigger blast radius and a bigger bill).

- [ ] **Step 5: Verify**

Run `cd presentation && npm test` — the new preset/slide are content, not code under test, but confirm nothing else broke. Then manually sanity-check the preset resolves and runs without error: a quick one-off `cpuScenario.run(resolvePreset(preset).params)` call (reuse your Step 2 script pattern, or write a fresh small check) confirming no exception and that `summary` looks like what the notes claim. Note in your report that VISUAL rendering of the new slide was not checked in a browser (no reliable browser tooling in this context) — flag it for the user to eyeball before presenting.

- [ ] **Step 6: Commit**

```bash
cd presentation && git add presets/latency-runaway.json slides.md
git commit -m "$(cat <<'EOF'
Add latency-runaway demo (autoscaling-talk-dbs)

Scaling on latency alone against a shared DB-pool bottleneck: instance
count climbs while latency doesn't recover, because the bottleneck
isn't capacity-shaped and more instances can't touch it. Numbers
measured, not guessed — see the preset's notes field.

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>
EOF
)"
```

---

### Task 8: full verification + cleanup

**Files:** any file touched by Tasks 1-7, as the cleanup pass finds issues.

- [ ] **Step 1: Full suite + typecheck**

Run: `cd presentation && npm test && npx tsc --noEmit -p sim/tsconfig.json`
Expected: PASS / clean.

- [ ] **Step 2: Grep for stale references**

`rg -n "hpaTarget|awsTarget\b" presentation --glob '!docs/**'` — `hpaTarget` should have zero hits outside historical spec/plan docs (it was removed in Task 5). `awsTarget` legitimately still exists (AWS target-tracking's own threshold param, unrelated to the removed `hpaTarget` — don't touch it). Also check `rg -n "cpuPct|lastCpuSeconds" presentation/sim` — should be zero hits (Task 6 deleted this).

- [ ] **Step 3: Cleanup pass**

Re-read `hpa.ts`, `shared.ts`'s `attachController`, and `metricRegistry.ts` fresh. Look for: leftover unused imports, the `shared.test.ts` placeholder test from Task 5 Step 1 (must have a real assertion by now, not a comment-only body), naming consistency (`id`/`metricId` used the same way everywhere), and whether `METRIC_IDS`/`METRIC_PARAM` (Task 5) would read more cleanly defined in `metricRegistry.ts` itself rather than `shared.ts` — if so, move them; if the current placement already reads fine, leave it (this is a "does it read awkwardly" judgment call, not a mandate).

- [ ] **Step 4: Re-run after cleanup**

Run: `cd presentation && npm test`
Expected: PASS.

- [ ] **Step 5: Update beads**

Run (from the repo root, not the worktree, if `bd` resolves issues by workspace root — check which directory `bd show autoscaling-talk-dsh` works from first):
```bash
bd close autoscaling-talk-dsh
bd close autoscaling-talk-dbs
```
Only close these if every task above is genuinely complete and reviewed clean — if anything was parked/deferred during execution, note it in the close comment instead of silently closing as if nothing was left open.

- [ ] **Step 6: Commit**

```bash
cd presentation && git add -A
git commit -m "$(cat <<'EOF'
Cleanup pass on multi-metric scaling

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>
EOF
)"
```
