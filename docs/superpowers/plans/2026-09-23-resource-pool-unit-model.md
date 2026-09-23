# Resource-pool unit model Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace `presentation/sim/instance.ts`'s flat `concurrency`/`unitModel` unit model with a generic, reusable `Pool` resource primitive and a per-request step pipeline, so CPU, worker occupancy, and (future) connection pools are all configurations of one mechanism instead of special-cased branches.

**Architecture:** New `Pool` class (`presentation/sim/pool.ts`) generalizes the `free[]`/`queue[]` slot bookkeeping `Instance` has today, adding a `poisonProb`-driven permanent-retirement mechanism. `Instance` is rewritten around a worker-pool envelope (held for the whole request) plus a per-request ordered step pipeline, each step acquiring a named `Pool` (instance-scoped or cluster-scoped) for a sampled duration. `Cluster` gains `clusterPools`, built once and shared by reference into every `Instance` it launches.

**Tech Stack:** TypeScript, Vitest. No new dependencies.

**Spec:** `docs/superpowers/specs/2026-09-23-resource-pool-unit-model-design.md`

## Global Constraints

- Use `vitest run` (via `presentation/package.json`'s `test` script) to run tests: `cd presentation && npm test`. Target a single file with `npx vitest run <path>`.
- Keep the sim deterministic: no `Math.random()` anywhere; all randomness goes through the seeded `Rng` (`presentation/sim/rng.ts`), threaded in via closures — the same pattern `bootTime`/`serviceTime` already use.
- `Pool` stays domain-agnostic (no `Request`/`Outcome` imports) — it only knows about slots, a queue, and a busy metric.
- Every new/changed public field needs a one-line doc comment, matching the existing style in `instance.ts`/`cluster.ts`.
- This plan does not touch `Cluster`'s instance lifecycle (launch/kill/crash/replace) beyond adding `clusterPools` — that logic is out of scope per the spec's Non-goals.

---

## File Structure

- Create `presentation/sim/pool.ts` — the `Pool` primitive.
- Create `presentation/sim/pool.test.ts` — its unit tests.
- Create `presentation/sim/test-helpers.ts` — a small `flatOpts()` helper so tests that don't care about the CPU/IO pool model (they just want "N concurrent slots, X ms each") don't have to hand-build a step pipeline. Used by 8 existing test files.
- Rewrite `presentation/sim/instance.ts` — worker-pool envelope + step pipeline.
- Rewrite `presentation/sim/instance.test.ts` — new behavior.
- Modify `presentation/sim/cluster.ts` — add `ClusterOpts.clusterPools`.
- Modify `presentation/sim/cluster.test.ts` — add shared-pool contention coverage.
- Modify `presentation/sim/scenarios/shared.ts` — new `unitParams`, `instanceOpts()`, `unitCapacity()`.
- Modify `presentation/sim/scenarios/shared.test.ts` — new param-mapping tests.
- Modify (mechanical, `InstanceOpts` shape only): `presentation/sim/faults.test.ts`, `cluster.test.ts` (its existing `setup()`), `lb.test.ts`, `integration.test.ts`, `cost.test.ts`, `controllers/hpa.test.ts`, `controllers/metrics.test.ts`, `controllers/aws.test.ts`, `upstream.test.ts`.
- Modify `presentation/profile/entry.ts` — internal perf-profiling harness param keys.
- Rewrite `presentation/presets/unit-model-compare.json` and update `presentation/slides.md:335` — the live demo slide, redone for the new model.
- Final cleanup pass across all touched files.

---

### Task 1: `Pool` primitive

**Files:**
- Create: `presentation/sim/pool.ts`
- Test: `presentation/sim/pool.test.ts`

**Interfaces:**
- Produces: `PoolOpts { slots: number; queueLimit?: number; poisonProb?: number }`, `class Pool { readonly busy: TimeWeighted; get slots(): number; get occupied(): number; get queued(): number; get poisonProb(): number; get retired(): number; tryAcquire(): number | undefined; enqueue(onGranted: (slot: number) => void): boolean; release(slot: number, poisoned: boolean): void; forceReset(): void }`. `Instance` (Task 2) and `Cluster` (Task 4) both import `Pool`/`PoolOpts` from this file.

- [ ] **Step 1: Write the failing tests**

```typescript
// presentation/sim/pool.test.ts
import { describe, expect, test } from 'vitest'
import { Sim } from './engine'
import { Pool } from './pool'

describe('Pool: acquire / queue / reject', () => {
  test('grants free slots immediately, tracks occupied', () => {
    const sim = new Sim()
    const p = new Pool(sim, { slots: 2 })
    expect(p.tryAcquire()).toBe(0)
    expect(p.occupied).toBe(1)
    expect(p.tryAcquire()).toBe(1)
    expect(p.occupied).toBe(2)
    expect(p.tryAcquire()).toBeUndefined()
  })

  test('enqueue succeeds within queueLimit, fails past it', () => {
    const sim = new Sim()
    const p = new Pool(sim, { slots: 1, queueLimit: 1 })
    p.tryAcquire()
    expect(p.enqueue(() => {})).toBe(true)
    expect(p.queued).toBe(1)
    expect(p.enqueue(() => {})).toBe(false)
    expect(p.queued).toBe(1)
  })

  test('release grants the next queued waiter, in order', () => {
    const sim = new Sim()
    const p = new Pool(sim, { slots: 1, queueLimit: 2 })
    const first = p.tryAcquire()!
    const granted: number[] = []
    p.enqueue((s) => granted.push(s))
    p.enqueue((s) => granted.push(-s - 1)) // distinguishable marker for the 2nd waiter
    p.release(first, false)
    expect(granted).toEqual([0])
    expect(p.queued).toBe(1)
    expect(p.occupied).toBe(1) // the granted waiter now occupies the slot
  })

  test('release with no queued waiter returns the slot to free', () => {
    const sim = new Sim()
    const p = new Pool(sim, { slots: 1 })
    const s = p.tryAcquire()!
    p.release(s, false)
    expect(p.occupied).toBe(0)
    expect(p.tryAcquire()).toBe(0)
  })
})

describe('Pool: poison retirement', () => {
  test('a poisoned slot never returns to free or to a queued waiter', () => {
    const sim = new Sim()
    const p = new Pool(sim, { slots: 1, queueLimit: 1 })
    const s = p.tryAcquire()!
    let granted = false
    p.enqueue(() => { granted = true })
    p.release(s, true)
    expect(granted).toBe(false)
    expect(p.tryAcquire()).toBeUndefined()
    expect(p.retired).toBe(1)
  })

  test('a poisoned slot still counts as occupied in the busy fraction', () => {
    const sim = new Sim()
    const p = new Pool(sim, { slots: 2 })
    const s = p.tryAcquire()!
    p.tryAcquire()
    p.release(s, true) // one slot poisoned, one still actively held
    expect(p.occupied).toBe(2) // both count as busy: one active, one permanently retired
  })
})

describe('Pool: busy metric', () => {
  test('busy.mean is time-weighted over occupied/slots', () => {
    const sim = new Sim()
    const p = new Pool(sim, { slots: 4 })
    const a = p.tryAcquire()!, b = p.tryAcquire()!
    sim.run(2)
    p.release(a, false)
    p.release(b, false)
    sim.run(2)
    expect(p.busy.mean).toBeCloseTo(0.25) // 0.5 occupied for 2 of 4 time units
  })

  test('forceReset zeroes occupied and busy, and clears the queue', () => {
    const sim = new Sim()
    const p = new Pool(sim, { slots: 1, queueLimit: 5 })
    p.tryAcquire()
    let granted = false
    p.enqueue(() => { granted = true })
    p.forceReset()
    expect(p.occupied).toBe(0)
    expect(p.busy.value).toBe(0)
    expect(p.queued).toBe(0)
    // the queued waiter must never fire, even if something tries to release into this pool later
    p.release(0, false)
    expect(granted).toBe(false)
  })
})
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd presentation && npx vitest run sim/pool.test.ts`
Expected: FAIL — `Cannot find module './pool'` (file doesn't exist yet).

- [ ] **Step 3: Implement `Pool`**

```typescript
// presentation/sim/pool.ts
import type { Sim } from './engine'
import { TimeWeighted } from './metrics'

export interface PoolOpts {
  slots: number
  /** Waiting room beyond `slots`; default 0 = reject when full. */
  queueLimit?: number
  /** Probability [0,1] that a slot is permanently retired on release after
   *  use (never returned to free, never granted to a queued waiter). Models
   *  a leaked/poisoned worker — a resource that's still "occupied" in the
   *  busy metric but will never do useful work again. */
  poisonProb?: number
}

/**
 * A fixed-size resource pool: acquire a slot, hold it, release it. Beyond
 * `slots`, callers can enqueue (FIFO, bounded by `queueLimit`) or must
 * reject. Generalizes what `Instance` used to hand-roll for its worker
 * slots; the same primitive now backs CPU, worker, and connection pools.
 */
export class Pool {
  readonly busy: TimeWeighted

  private free: number[] = []
  private waiters: Array<(slot: number) => void> = []
  private readonly queueLimit: number
  private _occupied = 0
  private _retired = 0

  constructor(sim: Sim, private opts: PoolOpts) {
    this.busy = new TimeWeighted(sim, 0)
    for (let i = 0; i < opts.slots; i++) this.free.push(i)
    this.queueLimit = opts.queueLimit ?? 0
  }

  get slots(): number { return this.opts.slots }
  get occupied(): number { return this._occupied }
  get queued(): number { return this.waiters.length }
  get poisonProb(): number { return this.opts.poisonProb ?? 0 }
  /** Slots permanently lost to poisoning. */
  get retired(): number { return this._retired }

  tryAcquire(): number | undefined {
    const i = this.free.pop()
    if (i === undefined) return undefined
    this._occupied++
    this.busy.set(this._occupied / this.opts.slots)
    return i
  }

  /** Queues `onGranted` to fire once a slot frees. False if the queue is also full — caller must reject. */
  enqueue(onGranted: (slot: number) => void): boolean {
    if (this.waiters.length >= this.queueLimit) return false
    this.waiters.push(onGranted)
    return true
  }

  /** `poisoned` is rolled by the caller — Pool stays rng-free, like the rest of the sim. */
  release(slot: number, poisoned: boolean): void {
    if (poisoned) {
      this._retired++
      // occupied count is unchanged: the slot is gone, not freed — it still
      // reads as permanently busy, which is the actual observable symptom.
      return
    }
    this._occupied--
    this.busy.set(this._occupied / this.opts.slots)
    const next = this.waiters.shift()
    if (next) {
      this._occupied++
      this.busy.set(this._occupied / this.opts.slots)
      next(slot)
    } else {
      this.free.push(slot)
    }
  }

  /** Owner (Instance) is discarding this pool — zero it out and drop any queued waiters, which must never fire. */
  forceReset(): void {
    this._occupied = 0
    this.waiters = []
    this.busy.set(0)
  }
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd presentation && npx vitest run sim/pool.test.ts`
Expected: PASS (10 tests)

- [ ] **Step 5: Commit**

```bash
cd presentation && git add sim/pool.ts sim/pool.test.ts
git commit -m "$(cat <<'EOF'
Add generic Pool resource primitive

Generalizes the free/queue slot bookkeeping Instance hand-rolls today,
plus a poisonProb-driven permanent-retirement mechanism for modeling
leaked/misconfigured workers. Foundation for the resource-pool unit
model (see docs/superpowers/specs/2026-09-23-resource-pool-unit-model-design.md).

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>
EOF
)"
```

---

### Task 2: `Instance` rewrite — worker-pool envelope + step pipeline

**Files:**
- Modify: `presentation/sim/instance.ts` (full rewrite)
- Modify: `presentation/sim/instance.test.ts` (full rewrite)

**Interfaces:**
- Consumes: `Pool`, `PoolOpts` from `./pool` (Task 1).
- Produces: `InstanceState`, `Work`, `Step = { pool: string; scope: 'instance' | 'cluster'; ms: number }`, `InstanceOpts { bootTime: number | (() => number); workerPool: PoolOpts; cpuPool: PoolOpts; instancePools?: Record<string, PoolOpts>; clusterPools?: Record<string, Pool>; steps?: () => Step[]; work?: Work; hungCpu?: number; rollUniform?: () => number }`, `class Instance` with the same public surface as today (`state`, `onDone`, `busy`, `launchedAt`, `readySince`, `inFlight`, `queued`, `utilization`, `hung`, `healthy`, `cpu`, `hang()`, `slow()`, `handle()`, `terminate()`) — `Cluster` (Task 4) and `scenarios/shared.ts` (Task 5) depend on this exact shape.

- [ ] **Step 1: Write the failing tests**

Replace the entire contents of `presentation/sim/instance.test.ts`:

```typescript
// presentation/sim/instance.test.ts
import { describe, expect, test } from 'vitest'
import { Sim } from './engine'
import { Instance, type InstanceOpts, type Step } from './instance'
import { Pool } from './pool'
import type { Outcome, Request } from './types'

function req(sim: Sim, id = 0): Request {
  return { id, arrivedAt: sim.now }
}

function cpuStep(ms: number): Step {
  return { pool: 'cpu', scope: 'instance', ms }
}

function make(sim: Sim, over: Partial<InstanceOpts> = {}) {
  const done: Request[] = []
  const inst = new Instance(sim, {
    bootTime: 0,
    workerPool: { slots: 1 },
    cpuPool: { slots: 1 },
    steps: () => [cpuStep(1)],
    ...over,
  })
  inst.onDone = (r) => { done.push(r) }
  return { inst, done }
}

describe('Instance lifecycle', () => {
  test('boots after bootTime, then is ready', () => {
    const sim = new Sim()
    const { inst } = make(sim, { bootTime: 5 })
    expect(inst.state).toBe('booting')
    sim.run(4.9)
    expect(inst.state).toBe('booting')
    sim.run(5)
    expect(inst.state).toBe('ready')
  })

  test('bootTime may be a sampler', () => {
    const sim = new Sim()
    const { inst } = make(sim, { bootTime: () => 3 })
    sim.run(3)
    expect(inst.state).toBe('ready')
  })

  test('request during boot is rejected', () => {
    const sim = new Sim()
    const { inst, done } = make(sim, { bootTime: 5 })
    inst.handle(req(sim))
    expect(done[0].outcome).toBe('rejected')
    expect(done[0].doneAt).toBe(0)
  })

  test('terminate kills in-flight and queued requests with error', () => {
    const sim = new Sim()
    const { inst, done } = make(sim, {
      workerPool: { slots: 1, queueLimit: 5 }, cpuPool: { slots: 1 }, steps: () => [cpuStep(10)],
    })
    sim.run(0)
    inst.handle(req(sim, 1))
    inst.handle(req(sim, 2))
    sim.run(3)
    inst.terminate()
    expect(inst.state).toBe('terminated')
    expect(done.map((r) => [r.id, r.outcome, r.doneAt])).toEqual([[1, 'error', 3], [2, 'error', 3]])
    inst.handle(req(sim, 3))
    expect(done[2].outcome).toBe('rejected')
  })

  test('terminate during boot leaves no ready transition', () => {
    const sim = new Sim()
    const { inst } = make(sim, { bootTime: 5 })
    sim.run(1)
    inst.terminate()
    sim.run(10)
    expect(inst.state).toBe('terminated')
  })
})

describe('Instance service', () => {
  test('serves request: startedAt, doneAt = start + step ms, outcome ok', () => {
    const sim = new Sim()
    const { inst, done } = make(sim, { steps: () => [cpuStep(2)] })
    sim.run(1)
    inst.handle(req(sim))
    sim.run()
    expect(done).toHaveLength(1)
    expect(done[0]).toMatchObject({ startedAt: 1, doneAt: 3, outcome: 'ok' })
  })

  test('multi-step plan runs steps in order, latency is the sum', () => {
    const sim = new Sim()
    const { inst, done } = make(sim, {
      cpuPool: { slots: 1 },
      instancePools: { io: { slots: 5 } },
      steps: () => [{ pool: 'io', scope: 'instance', ms: 3 }, cpuStep(2)],
    })
    inst.handle(req(sim))
    sim.run()
    expect(done[0]).toMatchObject({ doneAt: 5, outcome: 'ok' })
  })

  test('worker pool queues extra requests, serves them when a slot frees', () => {
    const sim = new Sim()
    const { inst, done } = make(sim, {
      workerPool: { slots: 2, queueLimit: 10 }, cpuPool: { slots: 2 }, steps: () => [cpuStep(1)],
    })
    for (let i = 0; i < 3; i++) inst.handle(req(sim, i))
    expect(inst.inFlight).toBe(2)
    expect(inst.queued).toBe(1)
    sim.run()
    expect(done.map((r) => [r.id, r.startedAt, r.doneAt])).toEqual([[0, 0, 1], [1, 0, 1], [2, 1, 2]])
  })

  test('worker queueLimit exceeded → rejected immediately', () => {
    const sim = new Sim()
    const { inst, done } = make(sim, { workerPool: { slots: 1, queueLimit: 1 } })
    inst.handle(req(sim, 0))
    inst.handle(req(sim, 1))
    inst.handle(req(sim, 2))
    expect(done.map((r) => [r.id, r.outcome])).toEqual([[2, 'rejected']])
  })

  test('a step whose pool is full and whose queue is also full rejects the whole request', () => {
    const sim = new Sim()
    const { inst, done } = make(sim, {
      workerPool: { slots: 2 }, cpuPool: { slots: 1, queueLimit: 0 }, steps: () => [cpuStep(10)],
    })
    inst.handle(req(sim, 0)) // takes the one cpu slot
    inst.handle(req(sim, 1)) // cpu full, no queue room → rejected, but still holds+releases its worker slot
    expect(done.map((r) => [r.id, r.outcome])).toEqual([[1, 'rejected']])
    expect(inst.inFlight).toBe(1) // request 0 still running; request 1's worker slot was released
  })

  test('a step queues for its pool: queueing time adds real latency', () => {
    const sim = new Sim()
    const { inst, done } = make(sim, {
      workerPool: { slots: 2 }, cpuPool: { slots: 1, queueLimit: 5 }, steps: () => [cpuStep(3)],
    })
    inst.handle(req(sim, 0))
    inst.handle(req(sim, 1)) // queues for the cpu slot for 3 units
    sim.run()
    expect(done.map((r) => [r.id, r.doneAt])).toEqual([[0, 3], [1, 6]])
  })

  test('custom work function replaces the default step pipeline', () => {
    const sim = new Sim()
    const { inst, done } = make(sim, {
      work: (_r, finish) => sim.schedule(7, () => finish('error')),
    })
    inst.handle(req(sim))
    sim.run()
    expect(done[0]).toMatchObject({ doneAt: 7, outcome: 'error' })
  })
})

describe('Instance worker poisoning', () => {
  test('poisonProb 1 retires the worker after one request; the next is rejected', () => {
    const sim = new Sim()
    const { inst, done } = make(sim, {
      // rollUniform defaults to 1, which never poisons even at poisonProb 1 (1 < 1 is
      // false) — that default is deliberately safe/inert; a real roll needs a real sampler.
      workerPool: { slots: 1, poisonProb: 1 }, steps: () => [cpuStep(1)], rollUniform: () => 0,
    })
    inst.handle(req(sim, 0))
    sim.run()
    inst.handle(req(sim, 1))
    expect(done.map((r) => [r.id, r.outcome])).toEqual([[0, 'ok'], [1, 'rejected']])
  })

  test('poisonProb 0 (default) never retires', () => {
    const sim = new Sim()
    const { inst, done } = make(sim, { workerPool: { slots: 1 }, steps: () => [cpuStep(1)] })
    for (let i = 0; i < 5; i++) { inst.handle(req(sim, i)); sim.run() }
    expect(done.every((r) => r.outcome === 'ok')).toBe(true)
  })

  test('rollUniform threads through: a roll below poisonProb retires, at/above does not', () => {
    const sim = new Sim()
    const rolls = [0.4, 0.6]
    let i = 0
    const { inst, done } = make(sim, {
      workerPool: { slots: 1, poisonProb: 0.5 }, steps: () => [cpuStep(1)],
      rollUniform: () => rolls[i++]!,
    })
    inst.handle(req(sim, 0)) // roll 0.4 < 0.5 → retired
    sim.run()
    inst.handle(req(sim, 1))
    expect(done.map((r) => [r.id, r.outcome])).toEqual([[0, 'ok'], [1, 'rejected']])
  })
})

describe('Instance cluster-scoped steps', () => {
  test('a cluster-scoped step acquires the shared Pool passed in via clusterPools', () => {
    const sim = new Sim()
    const db = new Pool(sim, { slots: 1, queueLimit: 1 }) // queueLimit: b must queue behind a rather than reject
    const { inst: a, done: doneA } = make(sim, {
      cpuPool: { slots: 1 }, clusterPools: { db }, steps: () => [{ pool: 'db', scope: 'cluster', ms: 5 }],
    })
    const { inst: b, done: doneB } = make(sim, {
      cpuPool: { slots: 1 }, clusterPools: { db }, steps: () => [{ pool: 'db', scope: 'cluster', ms: 5 }],
    })
    a.handle(req(sim, 0))
    b.handle(req(sim, 1)) // same shared db pool, only 1 slot → b queues behind a
    sim.run()
    expect(doneA[0]).toMatchObject({ doneAt: 5, outcome: 'ok' })
    expect(doneB[0]).toMatchObject({ doneAt: 10, outcome: 'ok' })
  })

  test('terminate releases a currently-held cluster-scoped slot back to the shared pool', () => {
    const sim = new Sim()
    const db = new Pool(sim, { slots: 1 })
    const { inst: a } = make(sim, {
      cpuPool: { slots: 1 }, clusterPools: { db }, steps: () => [{ pool: 'db', scope: 'cluster', ms: 100 }],
    })
    a.handle(req(sim, 0))
    expect(db.occupied).toBe(1)
    a.terminate()
    expect(db.occupied).toBe(0) // released back for other instances sharing this pool
  })
})

describe('Instance faults', () => {
  test('hang: in-flight requests complete only after the hang ends', () => {
    const sim = new Sim()
    const { inst, done } = make(sim, {
      workerPool: { slots: 4 }, cpuPool: { slots: 4 }, steps: () => [cpuStep(2)],
    })
    inst.handle(req(sim, 0)) // would finish at 2
    sim.run(1)
    inst.hang(10) // hung until 11
    sim.run()
    expect(done[0]).toMatchObject({ doneAt: 12, outcome: 'ok' }) // 1 unit of step left after 11
  })

  test('hang: new requests are accepted and finish after the hang + step', () => {
    const sim = new Sim()
    const { inst, done } = make(sim, {
      workerPool: { slots: 2 }, cpuPool: { slots: 2 }, steps: () => [cpuStep(1)],
    })
    inst.hang(10)
    inst.handle(req(sim, 0))
    inst.handle(req(sim, 1))
    inst.handle(req(sim, 2)) // no worker slot, no queue → rejected now
    expect(done.map((r) => [r.id, r.outcome, r.doneAt])).toEqual([[2, 'rejected', 0]])
    expect(inst.utilization).toBe(1)
    sim.run()
    expect(done.slice(1).map((r) => r.doneAt)).toEqual([11, 11])
  })

  test('hang: healthy is false while hung, true after', () => {
    const sim = new Sim()
    const { inst } = make(sim)
    expect(inst.healthy).toBe(true)
    inst.hang(5)
    expect(inst.healthy).toBe(false)
    sim.run(5)
    expect(inst.healthy).toBe(true)
  })

  test('cpu: reports the cpu pool busy fraction, hungCpu override while hung', () => {
    const sim = new Sim()
    const { inst } = make(sim, {
      workerPool: { slots: 4 }, cpuPool: { slots: 4 }, steps: () => [cpuStep(10)], hungCpu: 0,
    })
    inst.handle(req(sim, 0))
    expect(inst.cpu).toBe(0.25)
    inst.hang(5)
    expect(inst.cpu).toBe(0)
    sim.run(5)
    expect(inst.cpu).toBe(0.25)
  })

  test('cpu: hungCpu defaults to utilization (worker slots busy)', () => {
    const sim = new Sim()
    const { inst } = make(sim, {
      workerPool: { slots: 4 }, cpuPool: { slots: 4 }, steps: () => [cpuStep(10)],
    })
    inst.handle(req(sim, 0))
    inst.hang(5)
    expect(inst.cpu).toBe(0.25)
  })

  test('cpu with cores:1 is an honest event-loop-utilization metric', () => {
    const sim = new Sim()
    const { inst } = make(sim, {
      workerPool: { slots: 100 }, cpuPool: { slots: 1, queueLimit: 1 }, steps: () => [cpuStep(10)],
    })
    inst.handle(req(sim, 0))
    inst.handle(req(sim, 1)) // 2nd request's worker slot is held while it queues for the single cpu slot
    expect(inst.cpu).toBe(1) // the one core is fully busy, regardless of worker-pool size
    expect(inst.utilization).toBe(0.02) // 2 of 100 worker slots held — the honest concurrency picture
  })

  test('slow: multiplies instance-scoped step ms for new steps started during the fault', () => {
    const sim = new Sim()
    const { inst, done } = make(sim, {
      workerPool: { slots: 4 }, cpuPool: { slots: 4 }, steps: () => [cpuStep(1)],
    })
    inst.slow(3, 10)
    inst.handle(req(sim, 0))
    sim.run(10)
    inst.handle(req(sim, 1))
    sim.run()
    expect(done.map((r) => r.doneAt)).toEqual([3, 11])
  })

  test('slow does not multiply cluster-scoped steps', () => {
    const sim = new Sim()
    const db = new Pool(sim, { slots: 1 })
    const { inst, done } = make(sim, {
      cpuPool: { slots: 1 }, clusterPools: { db }, steps: () => [{ pool: 'db', scope: 'cluster', ms: 1 }],
    })
    inst.slow(3, 10)
    inst.handle(req(sim, 0))
    sim.run()
    expect(done[0]!.doneAt).toBe(1) // unaffected — a local-instance fault shouldn't inflate a shared upstream's time
  })

  test('booting instance is not healthy', () => {
    const sim = new Sim()
    const { inst } = make(sim, { bootTime: 5 })
    expect(inst.healthy).toBe(false)
  })
})

describe('Instance timestamps', () => {
  test('launchedAt and readySince', () => {
    const sim = new Sim()
    sim.run(3)
    const { inst } = make(sim, { bootTime: 5 })
    expect(inst.launchedAt).toBe(3)
    expect(inst.readySince).toBeUndefined()
    sim.run(8)
    expect(inst.readySince).toBe(8)
  })
})
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd presentation && npx vitest run sim/instance.test.ts`
Expected: FAIL — current `instance.ts` doesn't export `Step`, and `InstanceOpts` doesn't have `workerPool`/`cpuPool`.

- [ ] **Step 3: Implement the rewritten `Instance`**

Replace the entire contents of `presentation/sim/instance.ts`:

```typescript
// presentation/sim/instance.ts
import type { EventHandle, Sim } from './engine'
import { TimeWeighted } from './metrics'
import { Pool, type PoolOpts } from './pool'
import type { Outcome, Request } from './types'

export type InstanceState = 'booting' | 'ready' | 'terminated'

export type Work = (req: Request, finish: (outcome: Outcome) => void) => void

/** One step of a request's plan: acquire the named pool, hold it `ms`, release. */
export interface Step {
  pool: string
  scope: 'instance' | 'cluster'
  ms: number
}

export interface InstanceOpts {
  /** Delay before the instance can serve; number or sampler. */
  bootTime: number | (() => number)
  /** Envelope pool: held for a request's entire lifetime (arrival → completion). Models thread/coroutine count. */
  workerPool: PoolOpts
  /** The CPU pool — what `.cpu` reports. A step naming pool 'cpu' with scope 'instance' resolves here. */
  cpuPool: PoolOpts
  /** Other named instance-scoped pools (e.g. a local connection pool), built fresh per instance. */
  instancePools?: Record<string, PoolOpts>
  /** Cluster-scoped pools, shared by reference across every instance in the cluster (e.g. a DB pool). Wired in by Cluster. */
  clusterPools?: Record<string, Pool>
  /** Per-request step plan, built at arrival (same closure-sampling pattern as bootTime). Default: no steps (instant completion). */
  steps?: () => Step[]
  /** Override how a request is served (e.g. call an upstream) — bypasses `steps` entirely. */
  work?: Work
  /** CPU reported while hung (0 = stuck on I/O, 1 = spinning). Default: cpu pool's honest busy fraction. */
  hungCpu?: number
  /** Uniform [0,1) sampler used to roll poison on pool release. Default: never poisons. */
  rollUniform?: () => number
}

interface Occupant {
  req: Request
  plan: Step[]
  stepIndex: number
  /** The sub-resource currently held for the in-progress step, if any. */
  cur?: { pool: Pool; slot: number; scope: 'instance' | 'cluster' }
  handle?: EventHandle
  resumeAt?: number
}

/** One scaling unit: boots, then serves requests via a worker-pool envelope wrapping a per-request step pipeline. */
export class Instance {
  state: InstanceState = 'booting'
  onDone: (req: Request) => void = () => {}
  readonly busy: TimeWeighted
  readonly launchedAt: number
  readySince?: number

  private readonly workerPool: Pool
  private readonly cpuPool: Pool
  private readonly instancePools: Record<string, Pool>
  private readonly clusterPools: Record<string, Pool>
  private occupants: (Occupant | null)[]
  private workerQueue: Request[] = []
  private bootHandle?: EventHandle
  private hungUntil = -Infinity
  private slowUntil = -Infinity
  private slowFactor = 1

  constructor(private sim: Sim, private opts: InstanceOpts) {
    this.busy = new TimeWeighted(sim, 0)
    this.launchedAt = sim.now
    this.workerPool = new Pool(sim, opts.workerPool)
    this.cpuPool = new Pool(sim, opts.cpuPool)
    this.instancePools = {}
    for (const [name, poolOpts] of Object.entries(opts.instancePools ?? {})) this.instancePools[name] = new Pool(sim, poolOpts)
    this.clusterPools = opts.clusterPools ?? {}
    this.occupants = new Array(opts.workerPool.slots).fill(null)

    const boot = typeof opts.bootTime === 'function' ? opts.bootTime() : opts.bootTime
    const ready = () => { this.state = 'ready'; this.readySince = this.sim.now }
    if (boot === 0) ready()
    else this.bootHandle = sim.schedule(boot, ready)
  }

  get inFlight(): number { return this.workerPool.occupied }
  get queued(): number { return this.workerQueue.length }
  get utilization(): number { return this.workerPool.occupied / this.workerPool.slots }
  get hung(): boolean { return this.sim.now < this.hungUntil }
  /** What a health check sees: serving and not stuck. */
  get healthy(): boolean { return this.state === 'ready' && !this.hung }
  /** What a metrics agent reports — the cpu pool's honest busy fraction; lies while hung, by design. */
  get cpu(): number {
    if (this.hung) return this.opts.hungCpu ?? this.utilization
    return this.cpuPool.occupied / this.cpuPool.slots
  }

  /** Stop completing anything for `duration`; in-progress steps keep their occupant but push their timer out. */
  hang(duration: number): void {
    this.hungUntil = Math.max(this.hungUntil, this.sim.now + duration)
    for (let i = 0; i < this.occupants.length; i++) {
      const occ = this.occupants[i]
      if (!occ || !occ.cur || !occ.handle || occ.resumeAt === undefined) continue
      occ.handle.cancel()
      occ.resumeAt = this.hungUntil + Math.max(0, occ.resumeAt - this.sim.now)
      this.scheduleStepCompletion(i, occ)
    }
  }

  /** Instance-scoped step ms × `factor` for steps starting during `duration`. Cluster-scoped steps are unaffected — a local fault shouldn't inflate a shared upstream's time. */
  slow(factor: number, duration: number): void {
    this.slowFactor = factor
    this.slowUntil = this.sim.now + duration
  }

  handle(req: Request): void {
    if (this.state !== 'ready') return this.finish(req, 'rejected')
    const slot = this.workerPool.tryAcquire()
    if (slot !== undefined) return this.start(req, slot)
    const queued = this.workerPool.enqueue((s) => {
      const idx = this.workerQueue.indexOf(req)
      if (idx >= 0) this.workerQueue.splice(idx, 1)
      this.start(req, s)
    })
    if (queued) this.workerQueue.push(req)
    else this.finish(req, 'rejected')
  }

  terminate(): void {
    this.state = 'terminated'
    this.bootHandle?.cancel()
    const victims: Request[] = []
    for (const occ of this.occupants) {
      if (!occ) continue
      occ.handle?.cancel()
      if (occ.cur && occ.cur.scope === 'cluster') occ.cur.pool.release(occ.cur.slot, false)
      victims.push(occ.req)
    }
    victims.push(...this.workerQueue)
    this.workerQueue = []
    this.occupants = new Array(this.occupants.length).fill(null)
    this.workerPool.forceReset()
    this.cpuPool.forceReset()
    for (const pool of Object.values(this.instancePools)) pool.forceReset()
    for (const r of victims) this.finish(r, 'error')
  }

  private start(req: Request, workerSlot: number): void {
    req.startedAt = this.sim.now
    if (this.opts.work) {
      const occ: Occupant = { req, plan: [], stepIndex: 0 }
      this.occupants[workerSlot] = occ
      this.opts.work(req, (outcome) => {
        if (this.occupants[workerSlot] !== occ) return // instance terminated in the meantime
        this.finishWorker(workerSlot, occ, outcome ?? 'ok')
      })
      return
    }
    const occ: Occupant = { req, plan: this.opts.steps ? this.opts.steps() : [], stepIndex: 0 }
    this.occupants[workerSlot] = occ
    this.runStep(workerSlot, occ)
  }

  private runStep(workerSlot: number, occ: Occupant): void {
    if (occ.stepIndex >= occ.plan.length) return this.finishWorker(workerSlot, occ, 'ok')
    const step = occ.plan[occ.stepIndex]!
    let ms = step.ms
    if (step.scope === 'instance' && this.sim.now < this.slowUntil) ms *= this.slowFactor
    const pool = step.scope === 'cluster'
      ? this.clusterPools[step.pool]
      : step.pool === 'cpu' ? this.cpuPool : this.instancePools[step.pool]
    if (!pool) throw new Error(`unknown ${step.scope} pool "${step.pool}"`)
    const acquired = pool.tryAcquire()
    if (acquired !== undefined) return this.holdStep(workerSlot, occ, pool, acquired, ms, step.scope)
    const queued = pool.enqueue((s) => this.holdStep(workerSlot, occ, pool, s, ms, step.scope))
    if (!queued) this.finishWorker(workerSlot, occ, 'rejected')
  }

  private holdStep(workerSlot: number, occ: Occupant, pool: Pool, poolSlot: number, ms: number, scope: 'instance' | 'cluster'): void {
    if (this.occupants[workerSlot] !== occ) {
      // Instance terminated while this step waited in the pool's queue — don't leak a shared slot.
      if (scope === 'cluster') pool.release(poolSlot, false)
      return
    }
    occ.cur = { pool, slot: poolSlot, scope }
    occ.resumeAt = Math.max(this.sim.now, this.hungUntil) + ms
    this.scheduleStepCompletion(workerSlot, occ)
  }

  private scheduleStepCompletion(workerSlot: number, occ: Occupant): void {
    const { pool, slot: poolSlot } = occ.cur!
    occ.handle = this.sim.scheduleAt(occ.resumeAt!, () => {
      const poisoned = pool.poisonProb > 0 && this.rollUniform() < pool.poisonProb
      pool.release(poolSlot, poisoned)
      occ.cur = undefined
      occ.stepIndex++
      this.runStep(workerSlot, occ)
    })
  }

  private finishWorker(workerSlot: number, occ: Occupant, outcome: Outcome): void {
    this.occupants[workerSlot] = null
    const poisoned = this.workerPool.poisonProb > 0 && this.rollUniform() < this.workerPool.poisonProb
    this.workerPool.release(workerSlot, poisoned)
    this.finish(occ.req, outcome)
  }

  private rollUniform(): number {
    return this.opts.rollUniform ? this.opts.rollUniform() : 1
  }

  private finish(req: Request, outcome: Outcome): void {
    req.doneAt = this.sim.now
    req.outcome = outcome
    this.onDone(req)
  }
}
```

Note: `this.busy` (the top-level `TimeWeighted`) is kept but no longer separately maintained — it was already unused outside tests/exposure in the original code (nothing in `cluster.ts` or `scenarios/*.ts` reads `instance.busy`; `instance.utilization`/`instance.cpu` are what's actually consumed). Leave it constructed but unset (`TimeWeighted(sim, 0)`, never `.set()`) — this is dead weight inherited from the original design; flag it for removal in the Task 9 cleanup pass rather than deciding now.

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd presentation && npx vitest run sim/instance.test.ts`
Expected: PASS (all tests)

- [ ] **Step 5: Commit**

```bash
cd presentation && git add sim/instance.ts sim/instance.test.ts
git commit -m "$(cat <<'EOF'
Rewrite Instance around a Pool-backed worker envelope + step pipeline

Replaces the flat concurrency/unitModel model with a worker-pool
envelope (held for a request's full lifetime) wrapping an ordered
per-request step pipeline, each step acquiring a named instance- or
cluster-scoped Pool. cpu is now the CPU pool's honest busy fraction
(cores:1 is literally Node's eventLoopUtilization) instead of an
approximation. hang()/terminate() generalized to track per-occupant
step state.

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>
EOF
)"
```

---

### Task 3: `test-helpers.ts` — legacy flat-opts convenience

**Files:**
- Create: `presentation/sim/test-helpers.ts`

**Interfaces:**
- Consumes: `InstanceOpts` from `./instance` (Task 2).
- Produces: `flatOpts(o: { bootTime?: number | (() => number); serviceTime: () => number; concurrency: number; queueLimit: number; hungCpu?: number }): InstanceOpts`. Used by Task 6 (the 9 non-scenario test files) and Task 7 (profile harness).

- [ ] **Step 1: Implement `flatOpts`**

No test file for this one — it's a thin, obviously-correct mapping exercised transitively by every test file that uses it in Task 6/7. Writing a dedicated unit test for a 6-line pure function that's about to be called from 9 other test files (which will fail loudly if it's wrong) is test-for-test's-sake.

```typescript
// presentation/sim/test-helpers.ts
import type { InstanceOpts } from './instance'

/**
 * Convenience for tests that only care about "N concurrent slots, X ms
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
    steps: () => [{ pool: 'cpu', scope: 'instance', ms: o.serviceTime() }],
    hungCpu: o.hungCpu,
  }
}
```

- [ ] **Step 2: Typecheck**

Run: `cd presentation && npx tsc --noEmit -p sim/tsconfig.json`
Expected: no errors (this file compiles standalone; nothing calls it yet).

- [ ] **Step 3: Commit**

```bash
cd presentation && git add sim/test-helpers.ts
git commit -m "$(cat <<'EOF'
Add flatOpts test helper for the new InstanceOpts shape

Lets tests that only care about a flat concurrency+serviceTime instance
(not the CPU/IO pool model) avoid hand-building a step pipeline.

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>
EOF
)"
```

---

### Task 4: `Cluster.clusterPools`

**Files:**
- Modify: `presentation/sim/cluster.ts:6-9,19-26,69-75`
- Modify: `presentation/sim/cluster.test.ts`

**Interfaces:**
- Consumes: `Pool`, `PoolOpts` from `./pool` (Task 1); `InstanceOpts` shape from `./instance` (Task 2); `flatOpts` from `./test-helpers` (Task 3).
- Produces: `ClusterOpts { replaceDeadAfter?: number; clusterPools?: Record<string, PoolOpts> }` — `scenarios/shared.ts` (Task 5) will read this shape when wiring `clusterOpts(p)`.

- [ ] **Step 1: Update `cluster.test.ts`'s existing `setup()` helper and add new coverage**

In `presentation/sim/cluster.test.ts`, replace the import and `setup()` function:

```typescript
import { describe, expect, test } from 'vitest'
import { Sim } from './engine'
import { Cluster } from './cluster'
import { LoadBalancer } from './lb'
import { Pool } from './pool'
import { flatOpts } from './test-helpers'

function setup(sim: Sim, boot = 5) {
  const lb = new LoadBalancer(sim)
  const cluster = new Cluster(sim, lb, flatOpts({ bootTime: boot, serviceTime: () => 1, concurrency: 1, queueLimit: 0 }))
  return { lb, cluster }
}
```

Update every other `new Cluster(sim, lb, { bootTime: ..., serviceTime: () => ..., concurrency: ..., queueLimit: ..., hungCpu?: ... }, opts?)` call site in the file to `new Cluster(sim, lb, flatOpts({ ... same fields ... }), opts?)`.

Then append a new describe block:

```typescript
describe('Cluster.clusterPools', () => {
  test('instances launched by the same cluster share the same Pool object', () => {
    const sim = new Sim()
    const lb = new LoadBalancer(sim)
    const opts = {
      ...flatOpts({ serviceTime: () => 0, concurrency: 1, queueLimit: 0 }),
      steps: () => [{ pool: 'db', scope: 'cluster' as const, ms: 5 }],
    }
    const cluster = new Cluster(sim, lb, opts, { clusterPools: { db: { slots: 1, queueLimit: 1 } } }) // queueLimit: b must queue behind a rather than reject
    cluster.scaleTo(2)
    const [a, b] = cluster.instances
    a!.handle({ id: 0, arrivedAt: sim.now })
    b!.handle({ id: 1, arrivedAt: sim.now }) // same shared db pool, 1 slot → queues behind a
    const done: number[] = []
    a!.onDone = (r) => done.push(r.doneAt!)
    b!.onDone = (r) => done.push(r.doneAt!)
    sim.run()
    expect(done.sort((x, y) => x - y)).toEqual([5, 10])
  })
})
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd presentation && npx vitest run sim/cluster.test.ts`
Expected: FAIL — `cluster.ts` doesn't accept `clusterPools` yet, `Cluster` constructor signature mismatch on the new test, plus the `flatOpts`-based rewrites won't compile against the old `Cluster`/`InstanceOpts` shape (that mismatch is now resolved from Task 2, so it's specifically the new `clusterPools` test that fails).

- [ ] **Step 3: Implement `clusterPools`**

In `presentation/sim/cluster.ts`, update the imports and the top of the class:

```typescript
import type { Sim } from './engine'
import { Instance, type InstanceOpts } from './instance'
import type { LoadBalancer } from './lb'
import { TimeWeighted } from './metrics'
import { Pool, type PoolOpts } from './pool'

export interface ClusterOpts {
  /** Like an ASG health check: relaunch a crashed instance after this delay. */
  replaceDeadAfter?: number
  /** Cluster-scoped resource pools (e.g. a shared DB connection pool), built once and shared by reference into every instance this cluster launches. */
  clusterPools?: Record<string, PoolOpts>
}

/** The set of scaling units behind one LB. Launches and terminates instances. */
export class Cluster {
  launched = 0
  terminated = 0
  private pool: Instance[] = []
  private desired = 0
  private sizeOverTime: TimeWeighted
  private clusterPools: Record<string, Pool> = {}

  constructor(
    private sim: Sim,
    private lb: LoadBalancer,
    private instanceOpts: InstanceOpts,
    private opts: ClusterOpts = {},
  ) {
    this.sizeOverTime = new TimeWeighted(sim, 0)
    for (const [name, poolOpts] of Object.entries(opts.clusterPools ?? {})) {
      this.clusterPools[name] = new Pool(sim, poolOpts)
    }
  }
```

And update `launch()`:

```typescript
  private launch(): void {
    const inst = new Instance(this.sim, { ...this.instanceOpts, clusterPools: this.clusterPools })
    this.pool.push(inst)
    this.lb.add(inst)
    this.launched++
    this.sizeOverTime.set(this.pool.length)
  }
```

Everything else in `cluster.ts` (`scaleTo`, `crash`, `kill`, the `ready`/`utilization`/`cpu` getters) is unchanged.

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd presentation && npx vitest run sim/cluster.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
cd presentation && git add sim/cluster.ts sim/cluster.test.ts
git commit -m "$(cat <<'EOF'
Add Cluster.clusterPools: shared resource pools across an instance fleet

Built once per cluster, passed by reference into every Instance it
launches — the shared object identity is what makes cross-instance
contention real (e.g. a DB pool that scaling out instances doesn't scale).

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>
EOF
)"
```

---

### Task 5: `scenarios/shared.ts` — new unit params, `instanceOpts()`, `unitCapacity()`

**Files:**
- Modify: `presentation/sim/scenarios/shared.ts:71-140` (the `unitParams`/`unitCapacity`/`instanceOpts` block)
- Modify: `presentation/sim/scenarios/shared.test.ts`

**Interfaces:**
- Consumes: `InstanceOpts`, `Step` from `../instance` (Task 2).
- Produces: same exported names as before — `unitParams: ParamSpec[]`, `unitCapacity(p: Params): number`, `instanceOpts(p: Params, rng: Rng): InstanceOpts` — `scenarios/cpu.ts` and every other scenario file consume these by name only, unchanged.

- [ ] **Step 1: Write the failing tests**

Replace the entire contents of `presentation/sim/scenarios/shared.test.ts`:

```typescript
// presentation/sim/scenarios/shared.test.ts
import { describe, expect, test } from 'vitest'
import { Rng } from '../rng'
import { instanceOpts, unitCapacity, unitParams } from './shared'
import { defaults, type Params } from './types'

const base: Params = { ...defaults(unitParams) }

describe('instanceOpts: worker pool sizing', () => {
  test('Nworkers = cores * (cpu + io) / cpu, ceiled', () => {
    const o = instanceOpts({ ...base, cores: 4, cpuTimeMs: 10, ioWaitMs: 90 }, new Rng(1))
    expect(o.workerPool.slots).toBe(Math.ceil(4 * (10 + 90) / 10)) // 40
  })

  test('unlimitedWorkers bypasses the formula with a large sentinel', () => {
    const o = instanceOpts({ ...base, cores: 4, cpuTimeMs: 10, ioWaitMs: 90, unlimitedWorkers: true }, new Rng(1))
    expect(o.workerPool.slots).toBeGreaterThan(1000)
  })

  test('cpuPool sized to cores', () => {
    const o = instanceOpts({ ...base, cores: 8 }, new Rng(1))
    expect(o.cpuPool.slots).toBe(8)
  })

  test('queueSlots maps to workerPool.queueLimit', () => {
    const o = instanceOpts({ ...base, queueSlots: 40 }, new Rng(1))
    expect(o.workerPool.queueLimit).toBe(40)
  })

  test('poisonProb maps to workerPool.poisonProb', () => {
    const o = instanceOpts({ ...base, poisonProb: 0.01 }, new Rng(1))
    expect(o.workerPool.poisonProb).toBe(0.01)
  })
})

describe('instanceOpts: step plan', () => {
  test('default plan is one io step then one cpu step, sampled via the given rng', () => {
    const o = instanceOpts({ ...base, cpuTimeMs: 5, ioWaitMs: 20 }, new Rng(1))
    const plan = o.steps!()
    expect(plan.map((s) => [s.pool, s.scope])).toEqual([['io', 'instance'], ['cpu', 'instance']])
    expect(plan[0]!.ms).toBe(20)
    expect(plan[1]!.ms).toBe(5)
  })
})

describe('unitCapacity', () => {
  test('cores * 1000 / cpuTimeMs — the CPU-bound ceiling', () => {
    expect(unitCapacity({ ...base, cores: 4, cpuTimeMs: 20 })).toBe(4 * 1000 / 20)
  })
})
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd presentation && npx vitest run sim/scenarios/shared.test.ts`
Expected: FAIL — `cores`/`cpuTimeMs`/`ioWaitMs`/`unlimitedWorkers`/`poisonProb` aren't params yet, `instanceOpts()` still returns the old shape.

- [ ] **Step 3: Implement the new unit params + `instanceOpts()` + `unitCapacity()`**

In `presentation/sim/scenarios/shared.ts`, replace lines 69–140 (the `// ---------------- scaling unit ----------------` section through the end of `instanceOpts()`) with:

```typescript
// ---------------- scaling unit ----------------

export const unitParams: ParamSpec[] = [
  { key: 'cores', label: 'CPU cores', group: 'unit', kind: 'range', min: 1, max: 64, step: 1, default: 4,
    help: 'Physical cores per instance — the real bottleneck. Sizes the CPU pool. With cores: 1, cpu is literally Node\'s eventLoopUtilization.' },
  ...distParams({
    key: 'cpuTimeMs', label: 'CPU time', group: 'unit',
    help: 'Per-request CPU demand: time actually spent executing on a core.',
    base: { min: 1, max: 500, step: 1, default: 10, unit: 'ms' },
  }),
  ...distParams({
    key: 'ioWaitMs', label: 'I/O wait', group: 'unit',
    help: 'Per-request time spent waiting on I/O (DB, network) — doesn\'t consume a core, but still occupies the worker holding the request.',
    base: { min: 0, max: 2000, step: 10, default: 90, unit: 'ms' },
  }),
  { key: 'unlimitedWorkers', label: 'unlimited workers', group: 'unit', kind: 'toggle', default: false,
    help: 'Bypass the derived worker-pool size with an effectively-unbounded one — an explicit node.js-style "don\'t bound the worker pool" knob, on top of whatever the CPU/IO ratio already implies.' },
  { key: 'queueSlots', label: 'queue slots', group: 'unit', kind: 'range', min: 0, max: 512, step: 1, default: 32,
    help: 'Waiting room beyond the worker pool before rejecting. 0 = reject immediately when full.' },
  { key: 'poisonProb', label: 'worker poison probability', group: 'unit', kind: 'range', min: 0, max: 0.01, step: 0.0001, default: 0,
    help: 'Chance a served request permanently retires the worker that served it (never returns to the pool) — models a leaked thread in a misconfigured server that never recycles workers.' },
  ...distParams({
    key: 'bootSec', label: 'boot time', group: 'unit',
    help: 'Delay from launch until an instance can serve. The main source of dead time.',
    base: { min: 0, max: 600, step: 5, default: 120, unit: 's' },
  }),
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

/** Requests per second one instance can serve at 100% CPU — the CPU-bound ceiling. I/O overlaps for free given enough workers. */
export function unitCapacity(p: Params): number {
  return num(p, 'cores') * 1000 / num(p, 'cpuTimeMs')
}

/** Requests one instance can hold "in flight" without instant rejection when `unlimitedWorkers` is set. */
const UNBOUNDED_WORKERS = 5_000

export function instanceOpts(p: Params, rng: Rng): InstanceOpts {
  const hung = str(p, 'hungCpu')
  const cores = num(p, 'cores')
  const cpuTimeMs = num(p, 'cpuTimeMs'), ioWaitMs = num(p, 'ioWaitMs')

  const workers = bool(p, 'unlimitedWorkers')
    ? UNBOUNDED_WORKERS
    : Math.ceil(cores * (cpuTimeMs + ioWaitMs) / cpuTimeMs)

  return {
    bootTime: () => sampleDist(rng, p, 'bootSec'),
    workerPool: { slots: workers, queueLimit: num(p, 'queueSlots'), poisonProb: num(p, 'poisonProb') },
    cpuPool: { slots: cores },
    steps: () => [
      { pool: 'io', scope: 'instance', ms: sampleDist(rng, p, 'ioWaitMs') },
      { pool: 'cpu', scope: 'instance', ms: sampleDist(rng, p, 'cpuTimeMs') },
    ],
    instancePools: { io: { slots: UNBOUNDED_WORKERS } }, // I/O wait doesn't contend on a bounded resource of its own; the worker envelope already bounds concurrency
    hungCpu: hung === 'idle' ? 0 : hung === 'spinning' ? 1 : undefined,
    rollUniform: () => rng.next(), // real roll for workerPool.poisonProb — Instance's own default (rollUniform omitted) never poisons, so this must be supplied for poisonProb to do anything
  }
}
```

Two things to note for whoever implements this step:
1. The `io` instance pool is deliberately sized at `UNBOUNDED_WORKERS` (never the real bottleneck) — I/O wait's only job here is to occupy the worker envelope for its duration; it shouldn't *also* create a second, redundant point of contention. The worker-pool formula already accounts for it.
2. `sampleDist(rng, p, 'cpuTimeMs')`/`sampleDist(rng, p, 'ioWaitMs')` are called once each when `steps()` runs (per request) — this is the per-request PRNG draw the spec calls for. `unitCapacity()`/the `workers` formula above use the *base* param value (the floor/median), not a live sample, for sizing — consistent with how `bootSec`'s base value was already used for capacity-adjacent calculations elsewhere in this file.

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd presentation && npx vitest run sim/scenarios/shared.test.ts`
Expected: PASS

- [ ] **Step 5: Run the full scenario test suite to confirm no collateral breakage**

Run: `cd presentation && npx vitest run sim/scenarios/`
Expected: PASS — `cpu.ts`/`cpu.test.ts` and the other scenario files only consume `unitParams`/`instanceOpts`/`unitCapacity`/`neededInstances` by name, so they should need no changes. If `cpu.test.ts` fails, read the failure: it almost certainly means a test there asserts on the old `latencyMs`/`concurrency` param keys directly — fix those assertions to use `cpuTimeMs`/`cores` instead, following the same mapping used above, then re-run.

- [ ] **Step 6: Commit**

```bash
cd presentation && git add sim/scenarios/shared.ts sim/scenarios/shared.test.ts
git commit -m "$(cat <<'EOF'
Replace flat concurrency/unitModel params with cores + CPU/IO dists

unitParams: cores, cpuTimeMs/ioWaitMs (independent dist params, reusing
the existing floor+tail/lognormal picker), unlimitedWorkers,
poisonProb, queueSlots. instanceOpts() derives the worker-pool size
from Nworkers = cores*(cpu+io)/cpu and builds a two-step (io, cpu)
per-request plan. unitCapacity() becomes the CPU-bound throughput
ceiling: cores*1000/cpuTimeMs.

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>
EOF
)"
```

---

### Task 6: Update non-scenario test files to the new `InstanceOpts` shape

**Files:**
- Modify: `presentation/sim/faults.test.ts`
- Modify: `presentation/sim/lb.test.ts`
- Modify: `presentation/sim/integration.test.ts`
- Modify: `presentation/sim/cost.test.ts`
- Modify: `presentation/sim/controllers/hpa.test.ts`
- Modify: `presentation/sim/controllers/metrics.test.ts`
- Modify: `presentation/sim/controllers/aws.test.ts`
- Modify: `presentation/sim/upstream.test.ts`

**Interfaces:**
- Consumes: `flatOpts` from `../test-helpers` or `./test-helpers` depending on directory depth (Task 3).

This is mechanical: every one of these files constructs `InstanceOpts` (directly, or via `new Cluster(...)`) with the old flat shape `{ bootTime, serviceTime: () => N, concurrency: C, queueLimit: Q, hungCpu? }`. Replace each with `flatOpts({ bootTime, serviceTime: () => N, concurrency: C, queueLimit: Q, hungCpu? })`, importing `flatOpts` at the top of the file.

- [ ] **Step 1: `faults.test.ts`**

Add `import { flatOpts } from './test-helpers'` near the top. Replace:
```typescript
const cluster = new Cluster(sim, lb, { bootTime: 0, serviceTime: () => 1, concurrency: 4, queueLimit: 0 })
```
with:
```typescript
const cluster = new Cluster(sim, lb, flatOpts({ bootTime: 0, serviceTime: () => 1, concurrency: 4, queueLimit: 0 }))
```
and similarly for the `replaceDeadAfter` variant later in the file (line ~77), preserving the trailing `ClusterOpts` argument unchanged.

- [ ] **Step 2: `lb.test.ts`**

Add `import { flatOpts } from './test-helpers'`. Replace:
```typescript
const base: InstanceOpts = { bootTime: 0, serviceTime: () => 1, concurrency: 1, queueLimit: 0 }
```
with:
```typescript
const base: InstanceOpts = flatOpts({ bootTime: 0, serviceTime: () => 1, concurrency: 1, queueLimit: 0 })
```
The local `inst(over)` helper already does `{ ...base, ...over }` — since `flatOpts` output has `workerPool`/`cpuPool`/`steps` as top-level keys, every call site in this file that does `inst({ concurrency: 10 })` needs to become `inst({ workerPool: { slots: 10 }, cpuPool: { slots: 10 } })` (both, to match `flatOpts`'s "never contended" invariant), and `inst({ bootTime: 100, concurrency: 10 })` becomes `inst({ bootTime: 100, workerPool: { slots: 10 }, cpuPool: { slots: 10 } })`. There are 9 such call sites (lines 32, 41, 42, 51, 63, 84, 96, 120, 133, 147 per the earlier grep) — update each the same way.

- [ ] **Step 3: `integration.test.ts`**

Add the import. Replace the three `new Instance(sim, { bootTime: ..., serviceTime: () => ..., concurrency: N, queueLimit: ... })` call sites with `new Instance(sim, flatOpts({ bootTime: ..., serviceTime: () => ..., concurrency: N, queueLimit: ... }))`. Note one uses `queueLimit: Infinity` — `flatOpts` passes `queueLimit` straight through to `workerPool.queueLimit`, so `Infinity` still works (an unbounded queue).

- [ ] **Step 4: `cost.test.ts`**

Same pattern as `faults.test.ts`'s first call site.

- [ ] **Step 5: `controllers/hpa.test.ts`** and **Step 6: `controllers/aws.test.ts`**

Both have one call site of the shape:
```typescript
bootTime: () => (launches++ < ready ? 0 : boot), serviceTime: () => 1, concurrency: 10, queueLimit: 0,
```
inside a larger options object being passed to `new Cluster(...)`. Wrap that object's construction with `flatOpts({ ... })`, keeping the surrounding structure (check the full call site in context — this line is a fragment of a larger literal) intact.

- [ ] **Step 7: `controllers/metrics.test.ts`**

```typescript
const cluster = new Cluster(sim, lb, { bootTime: 0, serviceTime: () => 100, concurrency: 4, queueLimit: 0, hungCpu: 1 })
```
becomes
```typescript
const cluster = new Cluster(sim, lb, flatOpts({ bootTime: 0, serviceTime: () => 100, concurrency: 4, queueLimit: 0, hungCpu: 1 }))
```

- [ ] **Step 8: `upstream.test.ts`**

Only the `viaUpstream` test's `Instance` construction changes (line ~81-84):
```typescript
const inst = new Instance(sim, {
  ...flatOpts({ serviceTime: () => 0, concurrency: 5, queueLimit: 0 }),
  work: viaUpstream(sim, up, () => 1),
})
```
Everything else in this file (the `Upstream`/`UpstreamOpts` constructions) is unrelated and untouched.

- [ ] **Step 9: Run the full suite to verify**

Run: `cd presentation && npm test`
Expected: PASS across every file touched in this task, plus everything from Tasks 1–5 still passing.

- [ ] **Step 10: Commit**

```bash
cd presentation && git add sim/faults.test.ts sim/lb.test.ts sim/integration.test.ts sim/cost.test.ts sim/controllers/hpa.test.ts sim/controllers/metrics.test.ts sim/controllers/aws.test.ts sim/upstream.test.ts
git commit -m "$(cat <<'EOF'
Migrate remaining tests to the new InstanceOpts shape via flatOpts

Mechanical: these tests only need a flat concurrency+serviceTime
instance for Cluster/LB/controller/fault behavior, not the CPU/IO pool
model itself.

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>
EOF
)"
```

---

### Task 7: `profile/entry.ts` — perf-profiling harness

**Files:**
- Modify: `presentation/profile/entry.ts:25-26,39-40`

This file doesn't construct `InstanceOpts` directly — it sets `Params` fields consumed through `cpuScenario.run(p)` → `instanceOpts(p, rng)` (Task 5). It currently sets `p1.latencyMs = 100; p1.concurrency = 16` and the same pair for `p2`. Both params are gone after Task 5. No `flatOpts` involved here.

- [ ] **Step 1: Update the param assignments**

In `presentation/profile/entry.ts`, replace:
```typescript
p1.latencyMs = 100
p1.concurrency = 16
```
with:
```typescript
p1.cpuTimeMs = 100
p1.ioWaitMs = 0
p1.cores = 16
```
and the matching lines for `p2`:
```typescript
p2.cpuTimeMs = 100
p2.ioWaitMs = 0
p2.cores = 16
```
(`ioWaitMs: 0` keeps this an all-CPU workload, closest in spirit to the old single-`latencyMs` model; `cores: 16` is not a literal equivalent of the old `concurrency: 16` — it now means physical CPUs, not thread count, and the derived worker-pool size will differ from 16 — but exact fidelity doesn't matter for a dev perf-profiling script, it just needs valid, runnable params.)

- [ ] **Step 2: Verify the script still runs**

Run: `cd presentation && npx tsx profile/entry.ts`
Expected: runs without a TypeScript error, prints five timing lines (`warmup`, `aws-simple 1360rps` ×2, `hpa 4000rps` ×2) same as before.

- [ ] **Step 3: Commit**

```bash
cd presentation && git add profile/entry.ts
git commit -m "$(cat <<'EOF'
Update perf-profiling harness to the new unit params

latencyMs/concurrency are gone after the resource-pool unit model
migration; use cpuTimeMs/ioWaitMs/cores instead.

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>
EOF
)"
```

---

### Task 8: Redo the live `unit-model-compare` slide for the new model

**Files:**
- Modify: `presentation/presets/unit-model-compare.json` (full rewrite)
- Modify: `presentation/slides.md:335` (the `:expose` list)

**Interfaces:**
- Consumes: the new `unitParams` keys from Task 5 (`cores`, `cpuTimeMs`, `ioWaitMs`, `unlimitedWorkers`, `queueSlots`, `poisonProb`).

This slide currently demos `unitModel: loss` vs `unitModel: nodejs`, exposing `['unitModel', 'degradeGain', 'concurrency', 'queueSlots']`. Those params no longer exist (Task 5 removed them). Redo it to demo the new model's most analogous story: bounded threaded workers vs `unlimitedWorkers`, under the same identical sine load, showing that "unlimited workers" doesn't mean "unlimited capacity" — the CPU pool still saturates and latency balloons, which is a *more honest* version of the old story (the old one leaned on an approximated `cpuReport`; this one uses a real, measured CPU-pool busy fraction).

- [ ] **Step 1: Read the current preset and slide context**

```bash
cat presentation/presets/unit-model-compare.json
sed -n '330,345p' presentation/slides.md
```

- [ ] **Step 2: Rewrite the preset**

Replace the contents of `presentation/presets/unit-model-compare.json` with a preset whose base `params` set `unlimitedWorkers: false` (the default-off, bounded-worker-pool starting point the live toggle flips), under the same sine load the old preset used (period 200s — check the original file's `params` for the exact `ramp`/`periodSec`/`baseRps`/`rps` values and carry them over unchanged, only touching unit-group keys). Update `notes` to describe the new comparison: with `unlimitedWorkers` off, the worker pool itself becomes the bottleneck at a size derived from the CPU/IO ratio (loss behavior — clean, bounded errors); flipped on, workers never reject, but the CPU pool (`cores`) still saturates for real, so latency grows unbounded instead of shedding load — the failure mode moves from "clean rejection" to "silent queueing," same lesson as before, now backed by an honest metric instead of an approximation.

- [ ] **Step 3: Update the slide's exposed params**

In `presentation/slides.md:335`, change:
```
<Sim preset="unit-model-compare" :expose="['unitModel', 'degradeGain', 'concurrency', 'queueSlots']" :height="130" />
```
to:
```
<Sim preset="unit-model-compare" :expose="['unlimitedWorkers', 'cores', 'cpuTimeMs', 'queueSlots']" :height="130" />
```
Update the accompanying prose (the paragraph starting "Live DES from presets/unit-model-compare.json...") to match the new comparison's story instead of the old cpuReport-approximation one.

- [ ] **Step 4: Manually verify in the dev server**

Run: `cd presentation && npm run dev`, navigate to slide with the `unit-model-compare` preset, toggle `unlimitedWorkers` live, and confirm the charts render sensibly (errors near zero and bounded with it off, latency climbing with it on) — this is presentation content, not something a test file can verify. Report what you observed.

- [ ] **Step 5: Commit**

```bash
cd presentation && git add presets/unit-model-compare.json slides.md
git commit -m "$(cat <<'EOF'
Redo unit-model-compare slide for the resource-pool unit model

The old loss-vs-node.js demo relied on unitModel/degradeGain/concurrency,
all removed. New demo: unlimitedWorkers off vs on, same sine load —
shows the CPU pool saturating for real (honest metric) instead of the
old cpuReport approximation.

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>
EOF
)"
```

---

### Task 9: Full suite verification + cleanup pass

**Files:** any file touched by Tasks 1–8, as the cleanup pass finds issues.

- [ ] **Step 1: Run the full test suite**

Run: `cd presentation && npm test`
Expected: PASS, zero failures, across every `sim/**/*.test.ts` file.

- [ ] **Step 2: Typecheck the whole sim package**

Run: `cd presentation && npx tsc --noEmit -p sim/tsconfig.json`
Expected: no errors.

- [ ] **Step 3: Cleanup pass**

Re-read `instance.ts`, `pool.ts`, and `cluster.ts` fresh. Specifically look for:
- The dead `Instance.busy`/`TimeWeighted` field flagged in Task 2 Step 3 — confirm nothing reads it (grep `\.busy\b` across `presentation/sim`, excluding `pool.ts`'s own `Pool.busy` and `upstream.ts`'s unrelated `Upstream.busy`); if genuinely unused, remove the field, its import, and its constructor line from `Instance`.
- Any leftover reference to `latencyMs`, `concurrency`, `unitModel`, `degradeGain`, `queueSlots` (old meaning), `cpuReport`, or `UNBOUNDED_CONCURRENCY` anywhere in `presentation/` outside this plan/spec's own text (`rg -n "latencyMs|unitModel|degradeGain|cpuReport|UNBOUNDED_CONCURRENCY" presentation --glob '!docs/**'`).
- Duplication between `runStep`/`holdStep`'s pool-resolution logic (`scope === 'cluster' ? ... : ...`) — worth a tiny shared helper if it reads cleaner, but don't force it if extracting a 3-line ternary into its own method just adds indirection.
- Naming consistency: `workerSlot` vs `slot` vs `poolSlot` across `instance.ts` — make sure the same concept uses the same name throughout the file.

Fix what you find directly; this is a cleanup pass, not a design review — don't introduce new abstractions, just remove what's now dead and tighten what reads awkwardly.

- [ ] **Step 4: Re-run the full suite after cleanup**

Run: `cd presentation && npm test`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
cd presentation && git add -A
git commit -m "$(cat <<'EOF'
Cleanup pass on the resource-pool unit model

Removes dead code left over from the migration and tightens naming
consistency in the new Instance/Pool code.

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>
EOF
)"
```
