# Resource-pool unit model

Status: approved, pending implementation plan
Scope: `presentation/sim/` — `instance.ts`, `cluster.ts`, `scenarios/shared.ts`, new `pool.ts`

## Problem

The current unit model (`instance.ts`) treats "concurrency" as a single flat
number of slots, with three bolted-on flavors (`unitModel`: loss /
bounded-queue / nodejs) that each hack the slot count or service-time formula
differently (`degradeGain`, `cpuReport` approximation, `UNBOUNDED_CONCURRENCY`
sentinel). It has no notion of CPU vs I/O as distinct resources, so:

- There's no way to express "this handler is CPU-bound" vs "this handler
  mostly waits on I/O" — everything is one opaque `serviceTime`.
- The node.js event-loop model approximates event-loop-utilization with a
  hand-tuned formula (`cpuReport = min(1, inFlight/nominal)`) instead of
  measuring a real bounded resource.
- There's no way to model a resource shared across instances (a DB
  connection pool) or a second resource local to an instance (an outbound
  HTTP client pool) — everything is single-resource, per-instance.
- No way to model gradual, non-crashing capacity loss (a "leaked worker"
  failure mode), distinct from the existing sudden-fault repertoire in
  `faults.ts` (kill/hang/slow/upstream).

## Goal

Replace the flat concurrency model with a generic, reusable `Pool` resource
primitive, and model a request as an ordered pipeline of steps, each of
which acquires a named pool (instance-scoped or cluster-scoped) for a
sampled duration. CPU, I/O wait, worker occupancy, and connection pools
(instance- or cluster-scoped) all become configurations of the same
primitive — no more special-cased models in `instanceOpts`.

Concretely this must be able to express, with one mechanism:
- A threaded server: N worker threads, each doing blocking I/O then CPU.
- A node.js-style event loop: CPU pool of size 1, whose busy fraction is
  literally Node's `eventLoopUtilization` metric — not an approximation.
- A misconfigured server that silently leaks worker capacity over time
  (a request has some probability of poisoning the worker that served it;
  poisoned workers never return to the pool).
- (Follow-up, not this phase — see Non-goals) connection-pool exhaustion,
  instance-scoped or cluster-shared.

## Non-goals

- Building a new "DB connection exhaustion" scenario/UI. This phase ships
  the engine capability (`Pool`, `Cluster.clusterPools`, per-instance named
  pools) and proves it via the migrated CPU scenario. Building an actual
  scenario that exercises a cluster-shared pool is tracked separately in
  `autoscaling-talk-6du`, narrowed to that scope.
- Modeling instance lifecycle (boot/health/replace-dead) as pools. `Cluster`
  already handles this with a plain array + `scaleTo(n)` — there's no
  contention/queueing/rejection there, so `Pool`'s value (FIFO wait, reject
  past capacity) doesn't apply. Out of scope, not revisited by this design.
- Retry/backoff on a rejected request. Tracked separately (`xjm.11`,
  retry storms).
- Perf testing/tuning of the new step-pipeline. Explicitly deferred —
  tracked in a new follow-up issue (see Follow-ups).

## Design

### `Pool` primitive (new `presentation/sim/pool.ts`)

A straight generalization of the `free[]`/`queue[]`/`Slot` bookkeeping
`Instance` already has today, extracted so it can be reused for CPU,
worker, and connection-pool resources alike.

```ts
export interface PoolOpts {
  slots: number
  /** Waiting room beyond `slots`; default 0 = reject when full. */
  queueLimit?: number
  /** Probability [0,1] that a slot is permanently retired when released
   *  after use (never returned to `free`). Models a leaked/poisoned worker. */
  poisonProb?: number
}

export class Pool {
  readonly busy: TimeWeighted   // occupied-fraction over time (retired slots count as occupied)
  tryAcquire(): number | undefined
  /** Queues a waiter; returns false if queueLimit is also exhausted (caller must reject). */
  enqueue(onGranted: (slot: number) => void): boolean
  /** poisoned is rolled by the caller (Pool stays rng-free, consistent with
   *  the rest of the sim injecting Rng rather than owning it). */
  release(slot: number, poisoned: boolean): void
}
```

Retirement: a poisoned slot is marked permanently unavailable — never
returned to `free`, never granted to a queued waiter, and continues to
count as occupied in `busy` (a leaked worker looks busy forever, which is
the actual observable symptom of the failure this models).

### Request pipeline

A request plan is an ordered list of steps, each naming a pool (by name)
and scope, with a duration pre-sampled when the plan is built (same
closure-sampling pattern the codebase already uses for `serviceTime`/
`bootTime`):

```ts
type Step = { pool: string; scope: 'instance' | 'cluster'; ms: number }
```

The **worker pool is not a step** — it's the envelope held for the entire
request (arrival through completion), same role the current `concurrency`
slot plays today. `Instance.handle()`/`start()` keep their existing shape
(try worker pool, else enqueue, else reject), just backed by `Pool`
instead of the bespoke arrays.

Once a worker slot is held, the instance walks the step plan in order:
acquire the named pool (instance-scoped from the instance's own pool map,
cluster-scoped from a shared map handed in by `Cluster`), hold for `ms`,
release (rolling `poisoned` from that pool's `poisonProb` via the
instance's own rng), advance. If a step's pool is full and its queue is
also full, the whole request fails `'rejected'` — no partial retry. Last
step done → release the worker slot, finish `'ok'`.

Queueing at an intermediate step (e.g. waiting for a CPU slot mid-pipeline)
adds real latency and is exactly the "hog the worker while waiting"
behavior from the original ask, generalized: a worker can be alive and
holding its envelope slot while its request queues for a sub-resource.

### `Instance` integration

```ts
export interface InstanceOpts {
  bootTime: number | (() => number)
  workerPool: PoolOpts
  instancePools: Record<string, PoolOpts>   // e.g. { cpu: { slots: cores } }, built fresh per instance
  steps: () => Step[]                        // per-request plan, built at arrival
  hungCpu?: number
}
```

`Cluster` builds `clusterPools: Record<string, Pool>` once (from
`ClusterOpts.clusterPools?: Record<string, PoolOpts>`) and passes the same
`Pool` object references into every `Instance` it constructs — that shared
reference is what makes cross-instance contention real (e.g. a `db` pool
that scaling out instances does not scale).

**Complexity called out explicitly:** `hang()`/`terminate()` currently
track one timer per worker slot (`Slot.handle`/`finishAt`). Generalizing to
a multi-step plan means each occupied worker slot must track which step
it's on and which sub-pool slot it currently holds, so `hang()` can push
the right timer forward and `terminate()` can release the right
sub-resource (not just the envelope). This is a genuine rewrite of both
methods, not just the happy path, and is the highest-risk part of the
implementation.

### Metrics

- `instance.utilization` = worker pool's `busy` fraction — the
  concurrency/queueing picture (unchanged meaning from today).
- `instance.cpu` = CPU pool's `busy` fraction — an honest, measured metric
  instead of the old `cpuReport` approximation. With `cores: 1` this is
  literally Node's `eventLoopUtilization`; with `cores: N` it's real
  multi-core busy fraction.
- `hungCpu` lie-while-hung override is unchanged.
- `cluster.utilization`/`cluster.cpu` need no code changes — they already
  just average the instance getters.
- `unitCapacity(p)` (throughput ceiling used for autoscaler sizing)
  becomes `cores * 1000 / cpuTimeMs` — the CPU-bound ceiling; I/O overlaps
  for free given enough workers.

### Param surface (`scenarios/shared.ts`, `unitParams`)

Removed: `concurrency`, `unitModel`, `degradeGain`, the
`UNBOUNDED_CONCURRENCY` special-case branch, the `cpuReport` approximation.

Added/changed:
- `cores` (int, 1–64, default 4) → sizes `instancePools.cpu`
- `cpuTimeMs` dist params (reuses existing `distParams`/`sampleDist`)
- `ioWaitMs` dist params, independent draw
- `unlimitedWorkers` (toggle, default false) — bypasses the
  `Nworkers = ceil(cores*(cpu+io)/cpu)` formula with the existing
  `UNBOUNDED_CONCURRENCY` (5000) sentinel, for an explicit node.js-style
  "don't bound the worker pool" knob (io/cpu ratio already tends this way
  organically for I/O-heavy handlers, but this makes it explicit rather
  than relying on tuning the ratio).
- `poisonProb` (0–1, small default, e.g. 0 = disabled) → `workerPool.poisonProb`
- `queueSlots` — unchanged param, now feeds `workerPool.queueLimit`
- `hungCpu` — unchanged

`Nworkers` formula (unless `unlimitedWorkers`):
`ceil(cores * (cpuTimeMs + ioWaitMs) / cpuTimeMs)`.

### Migration

- `instance.ts`: rewrite — `Pool`-backed worker envelope, `instancePools`
  map, step-plan walker, generalized `hang()`/`terminate()`.
- `scenarios/shared.ts`: `unitParams` overhaul, `instanceOpts()` rewrite to
  build `workerPool`/`instancePools`/`steps` from the new params,
  `unitCapacity()` rewrite.
- `cluster.ts`: additive — `ClusterOpts.clusterPools`, built once,
  passed by reference into `Instance` construction. No change to existing
  lifecycle logic (launch/kill/crash/replace).
- Scenario files (`scenarios/cpu.ts` etc.): expected to need no changes —
  they only consume `shared.ts` helpers (`instanceOpts`, `unitCapacity`,
  `neededInstances`). Verify after implementation.

### Testing

- New `pool.test.ts`: `Pool` in isolation — acquire/queue/reject boundary,
  poison retirement (slot never returns, stays counted busy), `busy`
  metric correctness.
- `instance.test.ts`: rewritten — worker-pool accept/queue/reject,
  CPU-pool queueing adds latency, poison-on-release retirement end to end,
  `hang()`/`terminate()` mid-multi-step-pipeline cleanup, `cores: 1`
  busy-fraction sanity (event-loop-utilization case).
- `cluster.test.ts`: add coverage for a shared `clusterPools` resource
  contended across multiple instances.
- `scenarios/shared.test.ts`: updated for the new param set.
- Full `vitest run` (via `presentation/package.json`'s `test` script) at
  the end.

### Cleanup

A dedicated simplification pass after tests are green, before calling the
work done (per user instruction — "max cleanup").

## Follow-ups (new issues, not this phase)

- `autoscaling-talk-6du` (existing, narrowed): build an actual scenario
  that exercises `Cluster.clusterPools` (e.g. DB connection exhaustion
  under autoscaling) and/or an instance-scoped connection pool, using the
  engine capability this spec delivers. Presentation/scenario content, not
  engine work.
- New issue: perf testing and tuning of the step-pipeline model (explicitly
  deferred per user instruction, not part of this implementation).
