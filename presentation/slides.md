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
layout: section
---

# The Setup

Autoscaling is sold as reliability. It's a cost optimization with a feedback loop attached.

- A signal that scaled the wrong thing — and ran away
- A loop that oscillated until instances died before booting
- A scaler that overwhelmed the thing it depended on

Surprise bills and cascading failures aren't the exception. They're the default.

<!--
[3 min]
Autoscaling is sold as reliability, but it's really a cost optimization
with a feedback loop attached. Why surprise bills and cascading failures
are the norm rather than the exception. Sets up the three war stories
(wrong signal, oscillation, coupling) without naming them yet.
-->

---
layout: section
---

# Scaling on the Wrong Signal

- **CPU** — lags, and lies under IO wait, GC, or a degraded unit spinning idle
- **Throughput/instance** — good proxy, until upstream fails: less gets served, looks like less load, scaler pulls capacity *out*
- **Latency** — not a capacity signal. Caused by anything: upstream, GC, a bad deploy, a lock
- **Queue depth / concurrency** — closest to the truth

Little's Law grounds it: **L = λW**. Work in flight = arrival rate × time in system. Everything above is a proxy for one side of that equation.

<!--
[5 min]
A system scaled on latency ran away to hundreds of instances while fixing
nothing. Autoscaling can't solve problems that aren't capacity problems —
you still have to design and load-test for peak yourself.
-->

---
layout: section
---

# It's a Control System

- **Dead time** — boot time + metric delay. The gap between "order more capacity" and "capacity exists"
- **Characteristic time** — how fast the load itself changes. If it moves faster than dead time, the controller is always chasing
- **Gain** — how hard you react to error. Too high, you overshoot; too low, you never catch up
- **Sample period + cooldown** — a discrete controller. Can't react faster than it samples, can't correct a mistake faster than cooldown lets it move again

Sample slower than the load changes, and you're steering blind between samples — the textbook argument for why "just poll faster" isn't free.

k8s HPA and AWS ASG hand you these knobs with names that don't say so: `--horizontal-pod-autoscaler-sync-period`, stabilization windows, cooldowns, warm-up. Same physics, different defaults.

<!--
[6 min]
CPU-driven autoscaler oscillated so hard instances died before they
finished booting. Dead time, gain, cooldown, loop period — the knobs
everyone inherits as defaults and nobody tunes.
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
