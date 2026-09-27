# Queueing networks: what actually happens between the LB and the DB

A step-by-step explainer for the server-side queueing model behind the talk's
simulations. No queueing-theory background assumed — every term is defined
when it first appears. All the concrete numbers come from the sim's presets
(`presentation/presets/`), so you can reproduce every claim in the workbench.

The one-sentence summary: **a load balancer running least-connections, plus a
thread pool with a queue, turns the open internet into a closed population
circulating inside your server — and past a saturation knee, every queue slot
you add buys zero throughput and charges every request one bottleneck
service-time of latency.**

If that sentence doesn't mean anything yet, read on.

---

## 1. The machine we're modeling

A threaded server (Jetty, Gunicorn, most "workers + queue" runtimes) behind a
load balancer, with a shared database:

```text
internet → LB → [threads (c_t) + queue (K)] → io → db (c_db, shared) → cpu (c_c) → done
```

Each arriving request must win a **thread** (one of `c_t` = the sim's
`workers`). It holds that thread for its *entire* life inside the instance —
through I/O waits, through the database call, through CPU work. If no thread
is free, the request waits in the **queue** (`K` = the sim's `queueSlots`).
If the queue is full, the request is rejected — a fast error, a 503.

Three pieces of vocabulary, defined on first use:

- **Service demand (D)** — how long a stage works on one request, in
  milliseconds. The CPU stage's demand is `cpuTimeMs`; the DB stage's is
  `dbQueryMs`. Demand is a property of the *request*, not of the load.
- **Capacity (c)** — how many requests a stage can work on at once: `c_c`
  cores, `c_db` DB pool slots, `c_t` threads.
- **Utilization (ρ)** — the busy fraction of a stage: work arriving ÷ work
  the stage can do, i.e. ρ = λ·D/c for arrival rate λ. ρ = 0.8 means the
  stage is busy 80% of the time. There is one ρ per stage, and they are
  **not the same number**.

## 2. Little's law — the only formula you need

> **things-in-system = arrival rate × time-inside** (L = λ·W)

Average number of requests in a stage equals the arrival rate times the
average time a request spends there (waiting + being served). It holds for
any stable system, any arrival pattern, any scheduling discipline. Every
conclusion below is Little's law plus bookkeeping.

## 3. Open vs. closed networks

Queueing theory splits systems into two families, and the math — and the
failure modes — differ.

**Open network.** Customers arrive from *outside* (the internet), flow
through the stages, and leave. The arrival rate λ is exogenous: the internet
sends what it sends, regardless of how slow your server is. Classic results:
per-stage analysis, hyperbolic queue growth. As ρ → 1, mean waiting time at a
stage grows like ρ/(1−ρ): at ρ=0.5 a request waits about 0.5× the service
time, at ρ=0.9 it's 9×, at 0.99 it's 99×. The queue's *capacity* K changes
none of the averages — it only trades the far tail: without a queue the tail
experience is "instant 503", with a deep queue it's "wait a long time, then
time out."

**Closed network.** A *fixed population* of customers circulates among the
stages; nothing enters unless something leaves. The textbook example is N
users with think-time, but the one that matters here: **once the internet
sends faster than the stages can drain, your admission control (threads +
queue) clamps, and the server becomes a closed network with population**

> **N = c_t + K** — every admitted request, holding a thread, circulating
> between io, db, and cpu until it's done.

The arrival rate no longer matters: the population is set by your config.

## 4. The load balancer is what makes this interesting

The LB decides which instance gets each new request. Two canonical policies:

- **Round-robin**: stateless. Every instance gets every Nth request, no
  matter what it's doing. Under any variance in request cost, per-instance
  load drifts apart, and nothing corrects it.
- **Least-connections (LC)**: stateful. Send new work to the instance with
  the fewest active connections. This is a cousin of "join the shortest
  queue" (JSQ), the policy queueing theory knows keeps tail latency low,
  because it keeps per-instance load *even*.

Here's the part that changes the network type: **under LC, the signal from
the server to the LB is the response.** A connection is released the moment a
request finishes — and *that release* is what makes the instance eligible for
more traffic. One out, one in. So the LB↔server pair is a **closed feedback
loop**: work enters the server roughly as fast as work leaves it. The
internet is still open, but the server itself behaves like a closed network
being refilled at completion rate.

Two consequences of the loop:

1. **The loop has dead time.** The LB only samples the signal when the next
   arrival shows up. Between a release and the next dispatch, the instance's
   spare capacity is invisible — a burst that lands inside that window hits
   threads that are all busy. The queue is exactly what covers that window:
   the burst waits a moment instead of spilling to 503s. That's the *good*
   use of a queue, and the reason "queue = 0" is not automatically right.
2. **The loop is self-regulating once saturated.** If arrivals exceed what
   the internal stages drain, releases stop, the LB stops sending, and the
   instance settles into the closed regime of section 5 — population
   N = c_t + K, throughput set by the bottleneck, nothing more gets in.

## 5. The knee — where the dynamic changes

Take the closed regime and ask: what does throughput X and latency R look
like as a function of the population N?

- With N small, adding requests keeps the bottleneck stage busier (it covers
  the gaps while individual requests wait on slower stages). **X rises.**
- Past some population, the bottleneck stage — whichever has the smallest
  c/D, i.e. the smallest requests-per-second — is busy 100% of the time.
  **X flattens.** No population beyond that helps; the bottleneck is the
  bottleneck.
- Latency is Little's law with a fixed population: **R = N/X(N)**. Before the
  knee, X grows with N so R grows slowly. After the knee, X is capped, so
  **R grows linearly with N.**

That transition point is the **knee**, and it is the single most useful idea
in this document:

> **Below the knee: more concurrency buys throughput.
> Above the knee: more concurrency buys latency, linearly, forever.**

Where is the knee? The bottleneck stage has per-request demand D_max (the
biggest of the stages' demands); the total demand along the path is
D_total = Σ D_i. A customer needs the bottleneck roughly once per cycle, so
the knee sits around

> **N\* ≈ D_total / D_max**

Worked example, using the `db-outage-scalein` preset's server: cpuTimeMs=50
across 4 cores, ioWaitMs=50 (uncontended), dbQueryMs=30 across a shared pool
of 8. Per-request demands: CPU 50ms, io 50ms, db 30ms → D_total = 130ms. The
tightest per-instance stage is the CPU: D_max = 50ms/4 cores = 12.5ms of
"bottleneck time" per request. So **N\* ≈ 130/12.5 ≈ 10** concurrent requests
per instance. The preset configures 300 threads + 600 queue slots → **N = 900
— ninety times past the knee.** If that population ever filled up, latency
would be ≈ 900 × 12.5ms ≈ 11 seconds per request. It doesn't fill in
practice — because past ~5 concurrent requests the instance's throughput
ceiling (4 cores / 50ms = 80 rps) rejects the rest — but every slot in it is
a loaded gun.

The linear regime has a clean per-slot price tag:

> **Past the knee, each extra queue slot costs every request ≈ one
> bottleneck service demand of latency** — one customer in the circulation
> loop waits once at the bottleneck per cycle.

And the metric pathology: in the saturated closed regime **all stages read
100% busy by construction** — CPU, threads, DB — while X is flat at the
bottleneck's ceiling and R climbs. Utilization metrics cannot tell a healthy
saturated system from a dying one. That's not a monitoring failure; it's
what "closed" means. (This is exactly what the recovery phase of
`db-outage-scalein` and the end state of `thundering-herd` show.)

## 6. Tuning the tunables

With the two regimes in hand, every knob has a story. All knob names are the
workbench's.

### `queueSlots` (K) — the admission buffer

- **What it's for**: covering the LB loop's dead-time window (section 4.1) —
  micro-bursts that arrive between a response and the next dispatch.
- **Sizing rule**: ~one service cycle's worth of burst, not "more is safer."
  A few slots. Every slot past the knee costs every request one bottleneck
  demand of latency (section 5), paid invisibly at low load (the queue is
  empty almost surely — K=10 and K=10,000 are indistinguishable in normal
  metrics) and catastrophically at saturation.
- **The timeout interaction**: queue drain time must stay well under the
  client timeout (`clientTimeoutSec`). A queue slot that outlives the client
  converts a *fast* error into a *slow* error — and slow errors are the kind
  clients retry (see `thundering-herd`). Fast errors and slow errors are not
  the same failure; the queue decides which one you get.
- **"Keep it near zero"**: correct *given* your callers handle fast
  rejections well (backoff, failover, shedding upstream). The queue and the
  shedder are complements: the queue covers dead time, the shedder caps the
  population. They are not substitutes.

### `workers` (c_t) — the thread pool

- **What it's for**: keeping the bottleneck stage fed through waiting. A
  thread blocked on I/O or the DB isn't using a core; classic sizing
  c_t ≈ c_c × (total demand)/(CPU demand) — the sim's `unitParams` workers
  formula is exactly this.
- **Undersized**: cores idle waiting for threads. The CPU *understates* real
  demand; an autoscaler on CPU scales up and cannot fix it — the new pods
  arrive and starve their cores the same way.
- **Oversized (+ big K)**: a huge closed population past the knee. Graceful
  degradation removed: everything gets admitted, everything waits. The
  timeout interaction then converts the whole population into slow failures.
- Also note: the thread pool's throughput ceiling is **c_t / W_inside**, where
  W_inside is the full in-instance sojourn — including DB *wait* time. When
  the shared DB slows down, W_inside grows and the instance's admission
  ceiling shrinks proportionally. Upstream slowness arrives at your
  front door as fewer accepted requests per second.

### node.js — the missing c_t, and how to rebuild it

A node.js process has **no thread pool at the request layer**: the event loop
is a single server (c_c = 1 core of *your* JS code), and request concurrency
is unbounded — every arriving request is admitted, held in JS memory, and
awaited. In this document's terms: **c_t = ∞, K is moot, and N is no longer a
config knob — it floats with the internet.** Nothing clamps the population.

What that does to the model:

- The knee still exists (X_max = 1 core / per-request CPU demand), but with
  no admission boundary, load above X_max doesn't reject — it **piles up**.
  R = N/X_max with N growing as fast as requests arrive: latency climbs,
  memory grows, and since N never stops growing, there is no plateau to
  recover to. Load shedding never happens, so the closed-regime trick of
  "admission clamps, population stabilizes" is unavailable.
- In real node (unlike the sim), a large N makes it worse than linearly: more
  concurrent promises → more GC pressure → longer event-loop pauses → slower
  everything. That's the superlinear degradation curve (`rk6`) taking over,
  and it's why a loaded node process can go from "slow" to "unresponsive" in
  seconds. This is the sim's **event-loop server profile** (`unlimitedWorkers`),
  and the reason the **tuned-threads vs node.js** comparison (`pulse-compare-
  threaded-vs-event-loop`) shows the tuned pool absorbing the same pulse that
  drowns the event loop.
- And the scaler can't help: CPU reads ~100% (honest), but scaling pods adds
  *arrived-and-waiting* work only if the LB rebalances — each pod starts with
  an empty N, so it does help eventually, but every pod's population is
  unbounded again the moment load concentrates. You're feeding a firehose
  with a bigger funnel.

The fix is to **rebuild the admission boundary node doesn't give you**. Two
layers, both cheap:

1. **`server.maxConnections`** (net/http server option): the server stops
   accepting past the cap — excess connections sit in the OS accept backlog
   or get reset. Blunt and necessary: it acts at *connection* granularity,
   and with keep-alive one connection ≠ one request, so it bounds connections,
   not work. Think of it as the OS-level c_t: a ceiling that exists, but whose
   units are the wrong currency.
2. **In-flight-limit middleware**: a counter around the request handler — if
   active requests exceed the limit, respond **503 immediately**. This
   recreates the thread pool's admission boundary *exactly*: you choose the
   population N, rejection is fast and explicit, and clients get the "fast
   error" they handle best (retry with backoff, fail over). A dozen lines,
   one integer, request granularity. This is node's version of the
   well-behaved unit from the *Unstable Scaling Units* slide — and the
   counter **is** a metric the autoscaler can use: shedding-visible load
   instead of silently-piling load.

Sizing the middleware limit: same knee math, with c_c = 1. For a typical JS
request, the honest number is tens — not hundreds. Set it, reject above it,
and let the LB + clients do the rest. (And keep the 503 fast: a middleware
that queues "just a little" before rejecting has quietly rebuilt the unbounded
population with a bigger threshold.)

### `cores` (c_c) — the CPU pool

- The real capacity of the instance and the **honest utilization signal**.
  ρ_c is what a CPU-driven autoscaler sees, and it's the one number in the
  system that means what it says (caveat: only while threads are big enough
  to keep cores fed, per the undersized case above).

### `dbPoolSlots` (c_db) — the shared pool

- **Cluster-wide bottleneck**: X_max for the *whole cluster* is c_db/dbQueryMs
  (8/30ms = 266.7 rps in the presets) no matter how many instances you run.
- Per-instance tuning cannot fix it. Autoscaling the app tier against a
  saturated shared pool is the `latency-runaway` / `thundering-herd` story:
  the scaler adds instances, each instance raises the population hammering
  the same 8 slots, and R = N/X_max does the rest.
- When this stage is the bottleneck, the only real fixes are upstream of the
  queueing math: more DB capacity, caching, or moving work off the path.

### LB policy — which network you get

- **LC keeps the closed loop tight**: releases immediately refilled, per-
  instance load stays even, tails stay shorter than round-robin under the
  same burstiness (the JSQ result). Its signal — active connections — is
  also the *right* signal in the saturated regime.
- **Its blindnesses**: it can't see the queue depth (a full instance with an
  empty queue and one with 600 queued look identical: c_t connections), and
  its "connection" counts include I/O waits — so an io-heavy, core-idle
  instance looks busier than it is, and LC routes away from it, wasting CPU.
- **Round-robin**: simplest, stateless, fine when per-instance capacity is
  uniform and load is smooth; it never fixes drift, and K quietly absorbs
  the drift it causes.

### `clientTimeoutSec` — the far side of the contract

Every admission decision is a bet that you'll finish before the client gives
up. The queue, the thread pool, and the DB pool must jointly drain inside the
client timeout, or the client retries (amplifying load — foh.3) and the work
you committed is thrown away anyway. When in doubt: prefer failing fast over
committing to slow.

### And the autoscaler?

The autoscaler moves the **stages** (more cores, more instances → more
capacity → the knee moves right and X_max rises). But when the bottleneck
can't be scaled — the shared DB — the only remaining control surface is the
**population N**. Load shedding and backpressure are not coping strategies;
they are the mechanism that keeps a closed network at or below its knee when
capacity is fixed. That's load-shedding in system terms.

## 7. Cheat sheet

| knob | regime where it matters | what it buys | what it costs |
|---|---|---|---|
| queue slots K | above the knee | covers LB dead-time window | +1 bottleneck demand per slot, to every request |
| threads c_t | always | feeds bottleneck through waits; sets admission ceiling c_t/W_inside | oversized = huge closed population |
| cores c_c | always | real capacity; honest signal | the thing you actually autoscale |
| db pool c_db | when it's the bottleneck | sets X_max for the whole cluster | nothing you can tune per-instance |
| LB policy | bursty load, variance | even per-instance load → shorter tails (LC) | blind to queues; counts io waits |
| client timeout | everywhere | bounds your admission bet | retries when you break it |
| node.js: no c_t (by default) | above the knee | none — everything is admitted | unbounded population; fix = `maxConnections` + in-flight-limit middleware (503) |

## Further reading

- [Queue Theory for Node Developers](https://blog.nukemberg.com/presentation/queue-theory-for-node-developers/) — same ground, JSQ/M/M/c details
- [The Math of Scalability](https://blog.nukemberg.com/presentation/the-math-of-scalability/) — saturation curves and the knee, in Universal Scalability Law form
- The sim itself: `presentation/sim/README.md`, presets in
  `presentation/presets/` — every number in this doc is reproducible there.
