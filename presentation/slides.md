---
theme: default
title: 'Autoscaling: Cost Optimization Turned Reliability Nightmare'
info: |
  ## Autoscaling: Cost Optimization Turned Reliability Nightmare
  Reversim 2026
class: text-center
drawings:
  persist: false
transition: slide-left
comark: true
duration: 35min
mdc: true
# Deployed slides; QR codes (<Qr path=…>) resolve against this.
baseUrl: https://autoscaling-talk.example.com
---

# Autoscaling
## Cost Optimization Turned Reliability Nightmare

Reversim 2026

<!--
Total budget: ~32 min content + buffer to 35.
-->

---
layout: default
---

# Design for Max

<div class="text-left">

- You design and load-test for max load — autoscaling or not
- Shared resources don't scale linearly (USL)
- You're scaling **down** from max, not up from min

→ Autoscaling is a **cost optimization**, not a scaleout solution.

Treat it as scaleout, and you find out in prod you can't actually scale.

</div>

<!--
[1.5 min]
Why design-for-max is non-negotiable: shared resources (locks, DB
connections, caches) mean throughput doesn't scale linearly with
instance count — Universal Scalability Law, contention + coherency
terms. So "add more instances" has a ceiling regardless of autoscaler.
That ceiling has to be found and tested before prod, not discovered by
the autoscaler trying to climb to it live. Once max is known, autoscaling's
job is just: don't run at max when you don't have to. That's cost
optimization, not capacity engineering. Teams that skip this step find
out their "elastic" system hits the wall the first time it actually needs
to scale.
-->

---
layout: default
---

# What Could Possibly Go Wrong

<div class="text-left">

- Autoscaling ≠ preserve static capacity — it's **dynamic**
- Feedback loop attached → 🙄
- Dynamic failure modes. Worse than static ones.

</div>

<div class="text-left mt-6">

- Scaled the wrong signal — ran away
- Oscillated — instances died before booting
- Overwhelmed the thing it depended on

</div>

<!--
[1.5 min]
Static capacity fails in ways you can enumerate ahead of time: it's
either enough or it isn't. A feedback loop adds failure modes that only
exist because the loop exists — oscillation, runaway, coupling to what
it measures. Those are new categories, not more of the old one. Why
surprise bills and cascading failures are the norm rather than the
exception. Sets up the three war stories (wrong signal, oscillation,
coupling) without naming them yet.
-->

---
layout: default
---

# Scaling by Metrics, FTW! 🤦

<div class="text-left">

- **Load** metrics (queue depth, incoming throughput) vs **system response** (CPU, load avg, latency)
- Load metrics: usually not available
- Two dimensions to handle — time, and space (LB spreads load across servers)
- Know exactly what one server can handle? → queueing theory
- Load is compressible

</div>

<div class="text-left mt-6">

→ Most people end up on system response metrics. Welcome to a control theory problem.

</div>

<!--
[5 min]
The FTW is the setup, the facepalm is the reveal: metrics-based scaling
sounds obviously right, then doesn't work as advertised. Load metrics
(queue depth, incoming throughput) directly measure the thing you care
about, but they're rarely exposed and rarely per-instance — the LB
spreads load across servers, so it's a two-dimensional problem, time and
space, not just time. If you actually knew how much work one server can
handle, that's queueing theory (Little's Law: L = λW, work in flight =
arrival rate × time in system) — and load is compressible, so "how much
work" isn't even a fixed number. Nobody has that, so everyone falls back
to system response metrics (CPU, latency) as a proxy. A system scaled on
latency ran away to hundreds of instances while fixing nothing — latency
is caused by anything, not just capacity. That's the pivot into control
theory: once you're reacting to a response signal instead of the load
itself, you've built a feedback loop, with everything that implies.
-->

---
layout: default
---

# Control Theory Crash Course

<div class="text-left">

- **Characteristic time vs. dead time** — how fast load moves vs. how long you take to react
- **Gain** — how hard you react to error
- **Discrete sampling** — can't react faster than you sample; cooldown is a second limit
- **Stateful vs. stateless controllers** — memory rides out momentary fluctuations, at the cost of speed and complexity

</div>

<div class="text-left mt-6">

→ No control algorithm is perfect. There's **always** a tradeoff.

</div>

<!--
[6 min]
CPU-driven autoscaler oscillated so hard instances died before they
finished booting. Dead time, gain, cooldown, loop period — the knobs
everyone inherits as defaults and nobody tunes.

Quick framing before the four insights: continuous control (thermostat,
cruise control) vs discrete/sampled control (everything here — you only
see the world every sync-period). Same theory, sampling adds the extra
constraint below. We're using sims, not closed-form models, because
these loops are nonlinear and coupled enough that hand math stops being
useful fast — the simulator is standing in for the formal model.

1. Dead time = gap between "order more capacity" and "capacity exists".
   Characteristic time = how fast load itself moves. If load moves
   faster than dead time, the controller is always chasing, structurally.
2. Gain too high = overshoot/oscillation. Too low = never catches up.
3. Discrete controller: can't react faster than it samples, can't
   correct faster than cooldown lets it move again. Sample slower than
   the load changes and you're steering blind between samples — why
   "just poll faster" isn't free (Nyquist-ish, no math needed).
4. A stateless controller recomputes purely from current error each
   tick — reacts fast, cheap, but jumpy: a momentary blip moves it same
   as a real trend. A controller with memory (smoothing, integral
   term, tracking in-flight orders) rides out noise and doesn't
   double-order capacity that's already coming — but it's slower to
   react and more machinery to build and reason about. Most
   autoscalers you get by default are the naive stateless kind — guess
   what happens. (k8s's unready-pod set-aside is memory bolted onto an
   otherwise stateless loop — the exception, not the rule.)

k8s HPA / AWS ASG give these knobs names that don't say so:
sync-period, stabilization windows, cooldowns, warm-up. Same physics.
-->

---

# Oscillation, by Default

<Sim preset="cpu-oscillation" :expose="['baseRps', 'rps', 'algo', 'awsOutThreshold', 'awsInThreshold', 'awsCooldownSec', 'awsPeriodSec']" />

<!--
Live DES from presets/cpu-oscillation.json (scenario sim/scenarios/cpu.ts).
AWS simple scaling ±1, thresholds 0.55/0.45, cooldown 0, 15s period —
every knob turned to "responsive". Sustained flapping, by design. Tune
in the workbench (npm run bench), export JSON.
-->

---
layout: section
---

# Coupling and Blast Radius

<!--
[4 min]
Autoscaler overwhelmed the very database it depended on and triggered a
cascading failure. How scaling couples to upstream dependencies, the load
balancer, and fast-onset load.
-->

---
layout: section
---

# Unstable Scaling Units

<div class="text-left">

- **Well-behaved unit** — bounded concurrency, sheds fast, predictable capacity, boots fast, honest metrics
- **Bad unit** — unbounded threads, degrades instead of rejecting, lies about load

</div>

<div class="text-left mt-6">

→ The scaler can only be as good as the unit it's scaling.

</div>

<!--
[3 min]
Degrade vs. reject: what happens when a scaling unit is unhealthy but
still gets traffic. Why unstable units make every other problem worse.

Loss (Erlang-B, reject when full) is the well-behaved case — bounded
concurrency, predictable, and the CPU/busy-fraction metric tracks real
load honestly. The node.js-style unit never rejects; service time
inflates instead (event-loop contention, not thread exhaustion), so
the busy-fraction metric stays low relative to the inflated concurrency
ceiling right up until backlog explodes. The autoscaler sees a healthy
signal on an unhealthy system — it can't shed what it can't see. Live
demo on the next slide: flip unit model, same input, same knobs.
-->

---

# Loss vs. Node.js, Same Load

<Sim preset="unit-model-compare" :expose="['unitModel', 'degradeGain', 'concurrency', 'queueSlots']" />

<!--
Live DES from presets/unit-model-compare.json. Sine-wave load (period
200s) so the unit sees sustained variation, not just one step. Flip
"load-shedding model" from loss to node.js live: same input, errors go
from ~2% to over 50%, and the CPU metric barely moves because the
scaler's signal doesn't reflect the real backlog. That's the whole
point — the scaler is only as good as what the unit tells it.
-->

---
layout: section
---

# The Cost Problem

<!--
[3 min]
External actors, runaway upstream costs, no max. Autoscaling optimizes
cost until it doesn't — the failure mode nobody budgets for.
-->

---
layout: section
---

# Responsible Autoscaling

<!--
[6 min]
Design for max scale first, keep scaling units well-behaved, pick a
signal that tracks load, tune the loop, protect upstream. The real fix
is often less autoscaling: warm headroom, load shedding, backpressure.
-->

---
layout: section
---

# Summary

<!--
[2 min]
Simpler is often better. Don't run before you walk.
-->

---
layout: center
class: text-center
---

# Thank You

Questions?

---
layout: default
class: tradeoffs
---

# Bonus: every knob is a trade

<style>
.tradeoffs h1 { font-size: 1.6rem; margin-bottom: 0.4rem; }
.tradeoffs table { font-size: 0.8rem; line-height: 1.25; }
.tradeoffs td, .tradeoffs th { padding: 0.3rem 0.5rem; }
.tradeoffs th { font-weight: 700; text-align: left; }
.tradeoffs code { font-size: 0.75rem; }
</style>

<div>

| Knob | Kills | Costs |
|---|---|---|
| Scale-up rate limit | overshoot storms | big jumps arrive in installments |
| Scale-down stabilization | the second storm | 5 more minutes of peak bill |
| Cooldown | flapping | one move per 5 min |
| Instance warm-up | compounding orders | scale-in frozen meanwhile |
| Alarm datapoints | noise | +3 min to react, 15 min to shrink |
| Tolerance / dead band | chatter | "close enough" is the steady state |
| Lower target | dead-time exposure | idle capacity, always |
| Faster boot | dead time itself | engineering; warm pools aren't free |
| `max` | the runaway bill | an outage you chose |

</div>

<div class="mt-3 text-sm">

**No controller covers all cases.** Dead time · sampling period · saturating signal · gain on the wrong base — every fix for one is a cost on another. Headroom is the only thing that works *inside* the dead time.

</div>

<div class="abs-br m-4">
  <Qr path="docs/controller-tradeoffs.md" :size="120" />
</div>

<!--
Bonus slide — dense on purpose, for photos. Full notes in docs/controller-tradeoffs.md.
-->
