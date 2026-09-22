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

# Scaling on the Wrong Signal

<div class="text-left">

- **CPU** — lies under IO wait, GC, degraded units
- **Throughput/instance** — breaks when upstream fails
- **Latency** — not a capacity signal, caused by anything
- **Queue depth** — closest to the truth

**L = λW**

</div>

<!--
[5 min]
A system scaled on latency ran away to hundreds of instances while fixing
nothing. Autoscaling can't solve problems that aren't capacity problems —
you still have to design and load-test for peak yourself.

Little's Law: work in flight = arrival rate × time in system. Everything
on this slide is a proxy for one side of that equation. Throughput/instance
looks like less load exactly when upstream fails and the scaler pulls
capacity out — the opposite of what's needed.
-->

---
layout: default
---

# It's a Control System

<div class="text-left">

- **Dead time** — boot + metric delay
- **Characteristic time** — how fast load moves
- **Gain** — how hard you react
- **Sample period + cooldown** — a discrete controller

</div>

<!--
[6 min]
CPU-driven autoscaler oscillated so hard instances died before they
finished booting. Dead time, gain, cooldown, loop period — the knobs
everyone inherits as defaults and nobody tunes.

Dead time = gap between "order more capacity" and "capacity exists".
Characteristic time = if load moves faster than dead time, controller
always chases. Gain too high = overshoot, too low = never catches up.
Discrete controller: can't react faster than it samples, can't correct
faster than cooldown lets it move. Sample slower than the load changes
and you're steering blind between samples — why "just poll faster"
isn't free. k8s HPA / AWS ASG give these knobs names that don't say so:
sync-period, stabilization windows, cooldowns, warm-up. Same physics.
-->

---

# Oscillation, by Default

<Sim preset="cpu-step" :expose="['baseRps', 'rps', 'ramp', 'rampSec', 'algo', 'hpaScaleUpPods', 'hpaDownStabilizationSec', 'awsWarmupSec']" />

<!--
Live DES from presets/cpu-step.json (scenario sim/scenarios/cpu.ts).
HPA-style target tracking on busy fraction ("CPU"), target 50%, 16 slots/instance,
120s boot, 30s period, 60s window. Tune in the workbench (npm run bench), export JSON.
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

<!--
[3 min]
Degrade vs. reject: what happens when a scaling unit is unhealthy but
still gets traffic. Why unstable units make every other problem worse.
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
