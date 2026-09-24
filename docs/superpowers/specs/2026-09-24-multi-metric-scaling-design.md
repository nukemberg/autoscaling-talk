# Multi-metric scaling (dsh + dbs)

Status: approved, pending implementation plan
Scope: `presentation/sim/` — `instance.ts`, `controllers/metrics.ts`, `controllers/hpa.ts`, `scenarios/shared.ts`, `scenarios/cpu.ts`, new `scenarios/metricRegistry.ts`; `presentation/presets/` (new runaway-latency preset); `presentation/slides.md` (new demo slide, per dbs).
Tracks: `autoscaling-talk-dsh`, `autoscaling-talk-dbs`.

## Problem

The sim only supports CPU utilization as the scaling signal. Real autoscalers
watch multiple metrics simultaneously (HPA: multiple `metrics:` entries,
takes the max recommendation; AWS: one metric per policy, but the *choice*
of metric matters — CPU, request count per target, or a custom/external
metric are all real CloudWatch options). The sim can't currently demonstrate:

- HPA scaling on several signals at once (its actual, documented algorithm).
- Scaling on a metric that has *no relationship to remaining capacity* —
  the pedagogical point of `dbs`: autoscaling on end-to-end latency can spin
  up hundreds of instances while fixing nothing, because latency isn't a
  capacity signal, it's a queueing-under-contention symptom.

## Goal

A small, static metric registry (cpu, worker-pool utilization, queue depth,
requests/s per pod, latency) that both controller families read through the
same `PodMetrics`/`MetricSource` abstraction already in the codebase. HPA
gets real multi-metric support (per-metric desired, take the max). AWS
controllers get a metric selector (real CloudWatch alarms are single-metric,
so this is additive, not a rewrite). A new preset demonstrates the
latency-runaway failure mode.

## Non-goals

- A memory metric — needs a memory model in `Instance` that doesn't exist;
  explicitly deferred to a separate issue (per `dsh`'s own text).
- General "instances needed for an arbitrary metric/target" sizing math for
  the pre-run warmup. See **Initial sizing stays CPU-based** below for the
  scoping call this makes instead.
- Changing `PodMetrics` to scrape multiple sources per instance per tick.
  One `PodMetrics` instance already does one job well (one source, one
  scrape loop); multi-metric is handled by constructing **one `PodMetrics`
  per active metric**, all sharing the same `sampleInterval`. This is the
  smallest change that gets real multi-metric behavior — no changes to
  `PodMetrics` itself.

## Design

### 1. `Instance`: a served-requests counter (`dsh` bullet: "~10 lines")

Add a private monotonic counter, incremented in `finish()` only for
`outcome === 'ok'` (a rejected/errored request didn't consume real serving
capacity, so it shouldn't count toward a throughput metric):

```ts
private served = 0
get servedRequests(): number { return this.served } // cumulative — a counter, like cpuSeconds
```

In `finish()`: `if (outcome === 'ok') this.served++`. This is the ONLY
`instance.ts` change. `PodMetrics`'s existing `{ kind: 'counter', read }`
source shape rates it exactly like `cpuSeconds` — no `PodMetrics` changes
needed for this metric.

### 2. Metric registry (new `scenarios/metricRegistry.ts`, ~60 lines per `dsh`)

```ts
export interface MetricDef {
  id: string
  label: string
  unit: string
  /** 'utilization': 0..1-ish, chart gets a fixed [0,100] % scale, matches
   *  the existing unitCapacity-based initial-sizing math. 'absolute': chart
   *  auto-ranges, initial sizing falls back to the CPU-based estimate (see
   *  "Initial sizing stays CPU-based"). */
  kind: 'utilization' | 'absolute'
  source: MetricSource
  /** Sensible default target/threshold value for this metric's own units — used to seed
   *  hpaTarget*/awsTarget-style params so switching metrics doesn't leave a nonsensical default. */
  defaultTarget: number
}

export const metricRegistry: Record<string, MetricDef> = {
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
  // 'latency' is NOT a static entry — see "Latency: a cluster-wide metric
  // wearing a per-pod MetricSource" below. It's built by a factory that
  // needs the scenario's own `Stats` instance, unlike the four above.
}
```

`worker`'s `defaultTarget: 0.7` differs from `cpu`'s `0.5` deliberately —
worker-pool utilization saturates much later than CPU (a pool sized well
above `cores` per the earlier `workers` knob), so a 50% target on it would
scale out constantly for no reason; picked to give a similarly-late trigger
point.

### 3. Latency: a cluster-wide metric wearing a per-pod `MetricSource`

Latency isn't a per-instance quantity the sim already tracks per-pod — it's
tracked cluster-wide via `Stats` (`presentation/sim/stats.ts`), fed from the
LB's `onDone`. Real HPA's "External" metric type is exactly this shape: one
cluster-wide value, not averaged per-pod. To fit it into the existing
per-pod `PodMetrics`/`MetricSource` abstraction (rather than forking a
second code path through `Hpa`/`AwsPolicy`), model it as a **gauge source
that reports the same cluster-wide value for every instance**:

```ts
// scenarios/metricRegistry.ts
export function latencyMetric(stats: Stats, windowSec: number): MetricDef {
  return {
    id: 'latency', label: 'mean latency (OK requests)', unit: 'ms', kind: 'absolute', defaultTarget: 200,
    source: { kind: 'gauge', read: () => stats.latency(windowSec).mean * 1000 || 0 },
  }
}
```

Every "pod" reporting the identical value means `PodMetrics.value()`'s
per-pod averaging is a no-op (averaging N copies of the same number), and
`Hpa`'s "current × avg/target" formula degenerates correctly to "current ×
(global latency)/target" — the real External-metric formula, achieved
without a second formula. `windowSec` should track whatever the scrape
resolution already is (`metricsResolutionSec`), so a stale/instant reading
doesn't dominate — pass it through the same param.

This needs its own `PodMetrics` instance (like every other metric — see
Non-goals), constructed with this `source`, in `attachController`, only
when latency is one of the toggled metrics — it needs `Stats`, which
`attachController` doesn't currently receive, so its signature grows a
`stats: Stats` parameter (see `cpu.ts` wiring below).

### 4. `HpaOpts` and `Hpa.sync()`: real multi-metric support

```ts
export interface HpaMetric { metrics: PodMetrics; target: number; id: string }
export interface HpaOpts {
  metrics: HpaMetric[]   // replaces the single `target: number` + implicit single `metrics: PodMetrics` (constructor param)
  min: number
  max: number
  // ...unchanged: syncPeriod, tolerance, initialReadinessDelay, downStabilization, scaleUp*
}
```

`Hpa`'s constructor drops the standalone `metrics: PodMetrics` param (folded
into `opts.metrics`). `sync()`'s current body — computing `avg`, `ratio`,
`newRatio`, and the set-aside logic — becomes a private helper run once per
`HpaMetric`, returning `current` (no change) when there's no data or the
ratio is in-tolerance, and the computed desired count otherwise. `sync()`
itself becomes:

```ts
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
  if (!best) return // no metric had data from any pod this tick
  this.metric = best.metric
  this.recommend(best.desired)
}
```

`desiredForMetric(m, pods, current)` is the existing body (set-aside,
ratio, tolerance, scale-up/down formulas) parameterized on `m.metrics`
(which `PodMetrics` to read) and `m.target`, returning `{ desired, metric:
avg } | undefined` (undefined when no pod had data for this metric this
tick — real HPA skips a metric it can't retrieve rather than failing the
whole sync). `this.metric` (the single number the chart/status shows)
becomes whichever metric's computation produced the max desired count — the
one actually driving the decision, which is the most useful thing to chart.

`recommend()`, `replicasAt()`, stabilization/rate-limiting: **unchanged** —
they already operate on a single `rec: number` regardless of how many
metrics fed into it.

### 5. AWS controllers: unchanged code, a metric selector at the wiring layer

`AwsPolicy` and its three subclasses already take one `PodMetrics` and one
`target`/`threshold` set of generic numbers — nothing about them assumes
CPU specifically. No changes to `controllers/aws.ts`. The only new work is
in `attachController`: pick ONE `PodMetrics` (whichever metric is selected
for AWS — see param design below) instead of always constructing the
CPU-only one.

### 6. Param surface (`scenarios/shared.ts`)

Per-metric toggle + target, matching `dsh`'s own sketch exactly (avoids
inventing a new `ParamSpec` "multi-select" kind):

```ts
// One toggle + target pair per registry metric, shared verbatim between HPA and AWS —
// AWS only ever uses the first toggled-on one (real CloudWatch alarms are single-metric).
{ key: 'metricCpu', label: 'CPU utilization', kind: 'toggle', default: true, group: 'scaler', help: '...' },
{ key: 'metricCpuTarget', label: 'target', kind: 'range', min: 0.1, max: 1, step: 0.05, default: 0.5, group: 'scaler', activeWhen: { metricCpu: 'true' }, help: '...' },
{ key: 'metricWorker', label: 'worker pool utilization', kind: 'toggle', default: false, group: 'scaler', help: '...' },
{ key: 'metricWorkerTarget', label: 'target', kind: 'range', min: 0.1, max: 1, step: 0.05, default: 0.7, group: 'scaler', activeWhen: { metricWorker: 'true' }, help: '...' },
{ key: 'metricQueue', label: 'queue depth', kind: 'toggle', default: false, group: 'scaler', help: '...' },
{ key: 'metricQueueTarget', label: 'target', kind: 'range', min: 0, max: 50, step: 1, default: 5, group: 'scaler', activeWhen: { metricQueue: 'true' }, help: '...' },
{ key: 'metricRps', label: 'requests/s per pod', kind: 'toggle', default: false, group: 'scaler', help: '...' },
{ key: 'metricRpsTarget', label: 'target', kind: 'range', min: 1, max: 500, step: 1, default: 50, group: 'scaler', activeWhen: { metricRps: 'true' }, help: '...' },
{ key: 'metricLatency', label: 'latency (mean, OK)', kind: 'toggle', default: false, group: 'scaler', help: '...' },
{ key: 'metricLatencyTarget', label: 'target ms', kind: 'range', min: 10, max: 2000, step: 10, default: 200, group: 'scaler', activeWhen: { metricLatency: 'true' }, help: '...' },
```

Replaces the old single `hpaTarget`/`awsTarget` params entirely (both
become "the target of whichever metric is toggled" — for `hpaTarget`
specifically, that meant CPU only before; now CPU is just the
default-on metric, same effective default behavior for anyone who
doesn't touch the new toggles). `awsOutThreshold`/`awsInThreshold` (step
and simple scaling) are unaffected in shape — they're already
generic "above/below a number" thresholds; they now compare against
whichever single metric is selected, same as `awsTarget` does for target
tracking.

**If nothing is toggled on** (a user turns off `metricCpu` without turning
anything else on): fall back to `metricCpu: true` behavior at the wiring
layer (`attachController`) rather than erroring — a scenario with zero
metrics can't scale at all, which isn't an interesting or intended state to
expose.

### 7. `attachController` wiring

```ts
export function attachController(sim: Sim, cluster: Cluster, p: Params, stats: Stats): Controller {
  const interval = num(p, 'metricsResolutionSec')
  const active = (['cpu', 'worker', 'queue', 'rps', 'latency'] as const)
    .filter((id) => bool(p, `metric${capitalize(id)}`))
  const ids = active.length ? active : ['cpu']

  const metricsFor = (id: string): PodMetrics => {
    const def = id === 'latency' ? latencyMetric(stats, interval) : metricRegistry[id]
    const m = new PodMetrics(sim, cluster, { sampleInterval: interval, source: def.source })
    m.start()
    return m
  }

  // ...existing algo switch; 'default' (hpa) branch becomes:
  default:
    c = new Hpa(sim, cluster, {
      metrics: ids.map((id) => ({ metrics: metricsFor(id), target: num(p, `metric${capitalize(id)}Target`), id })),
      min, max, tolerance: ..., syncPeriod: ..., /* unchanged rest */
    })
}
```

AWS branches use `metricsFor(ids[0])` for their single `PodMetrics`
argument, everything else in those branches unchanged.

`stats` is a new required parameter — `attachController`'s one call site
(`scenarios/cpu.ts`) already constructs a `Stats` before calling it, so
this is a same-file, same-call, add-one-argument change, not a new
dependency the caller has to build.

### 8. Chart wiring (`scenarios/cpu.ts`)

Replace the hand-rolled `cpuPct` probe (which duplicates, in an
ad-hoc way, exactly what the controller's own `.metric` already computes)
with reading the controller directly:

```ts
const controller = attachController(sim, cluster, p, stats)
// ...
const rec = new Recorder(sim, sample, {
  instances: () => cluster.size,
  ready: () => cluster.ready,
  inRotation: () => lb.readyCount,
  metric: () => controller.metric,   // was: cpu: cpuPct
  // ...
})
```

Chart series key renames `cpu` → `metric` with a label/scale that adapts:
since a chart's `series[].scale`/`label` are static (set once when the
`ScenarioDef.charts` array is built, not per-run), and the ACTIVE metric
can change per-run via params, the top chart's secondary scale can't be
statically labeled "cpu %" anymore. Simplest fix matching how one other
scale already works in this file: keep a fixed **[0, 100] "value" scale**
used generically — utilization-kind metrics (cpu, worker) are ×100'd same
as today; absolute-kind metrics (queue, rps, latency) are NOT naturally
0-100, so they get plotted on the *same* axis unconverted, understanding
that the presenter picks a load range that keeps them visually readable
(this mirrors how the existing latency chart's y-axis already auto-ranges
per-run — no new auto-ranging machinery needed, just accept the top chart's
right axis is honestly labeled "metric" rather than "cpu %" and stops
promising a fixed 0-100% meaning when a non-utilization metric is active).
Precisely: multiply by 100 only when `kind === 'utilization'`.

### 9. Initial sizing stays CPU-based (explicit scope limit)

`neededInstances()`/`targetUtilization()` currently assume "CPU utilization
× unitCapacity()" to size the cluster for `baseRps` before the run starts.
General "instances needed to hit an arbitrary target on an arbitrary
metric" has no closed form for a metric like latency (not linear in
instance count) — solving that generally is out of scope. **These two
functions are left reading `hpaTarget`-shaped CPU semantics specifically —
they now read `metricCpuTarget` when CPU is toggled on, and fall back to
the CPU registry entry's `defaultTarget` (0.5) when it isn't.** This means
a scenario that scales on, say, rps-per-pod alone will still *start*
CPU-sized (a reasonable approximation of the right ballpark) and let the
actual controller correct from there once the run begins — consistent with
how the sim already tolerates an imperfect starting point elsewhere (e.g.
AWS target tracking's own warm-up transient).

### 10. `dbs`: the latency-runaway preset

A new preset (`presentation/presets/latency-runaway.json`) and a
corresponding slide (mirroring how `unit-model-compare`/`cpu-oscillation`
are wired into `slides.md`): HPA scaling on `metricLatency` alone, under a
load shape chosen so that latency degrades for a reason autoscaling can't
fix (the natural candidate already in this codebase: a `slow` fault, or
sustained I/O-wait-heavy load where latency rises from queueing at a
downstream/shared resource — `queueSlots`/`ioWaitMs` already model exactly
this). The demo: instance count climbs into the hundreds (or hits
`maxInstances`) while latency never recovers, because the actual problem
(e.g. a slow fault, or contention on a resource unrelated to instance
count) isn't capacity-shaped. Exact numbers get tuned empirically once the
registry/controller work lands — this preset is the last implementation
task, after the metric plumbing exists to build it with.

## Testing

- `instance.test.ts`: `servedRequests` increments on `'ok'` only, not on
  `'rejected'`/`'error'`.
- New `metricRegistry.test.ts`: each static entry's `source.read` reads the
  right `Instance` field; `latencyMetric()` reports the same value
  regardless of which instance is passed (the degenerate-per-pod property
  this whole design leans on).
- `hpa.test.ts`: rewrite call sites for the new `HpaOpts.metrics` array
  shape (mechanical — existing tests pass a single metric, now wrapped in a
  one-element array). New test: two metrics, one wanting more replicas than
  the other → the max wins, `Hpa.metric` reports the driving metric's
  value, not the other one's.
- `aws.test.ts`: unaffected (no code changes there) — confirm existing
  tests still pass unmodified against the metric-selector wiring change
  (they construct `PodMetrics` directly in tests, bypassing
  `attachController`, so this should be a non-event, but verify).
- `shared.test.ts`: `attachController` with multiple `metricX` toggles on
  produces an `Hpa` with a multi-element `metrics` array; zero toggles on
  falls back to CPU-only.
- `cpu.test.ts`: update the chart-series assertions for the `cpu` → `metric`
  rename; existing scenario tests (kill fault, hang fault, etc.) should be
  otherwise unaffected since they don't toggle any new metric params
  (default: CPU-only, matching today's behavior).
- Full `vitest run` at the end.

## Follow-ups (not this work)

- Memory as a scaling metric — needs an `Instance` memory model first
  (explicitly deferred per `dsh`).
- General non-CPU initial-sizing math, if a future scenario specifically
  needs the "before" state sized correctly for a non-CPU-toggled run.
