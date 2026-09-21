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

<!--
[3 min]
Autoscaling is sold as reliability, but it's really a cost optimization
with a feedback loop attached. Why surprise bills and cascading failures
are the norm rather than the exception.
-->

---
layout: section
---

# Scaling on the Wrong Signal

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
.tradeoffs code { font-size: 0.75rem; }
</style>

<div>

| knob | removes | costs |
|---|---|---|
| scale-up rate limit — HPA `max(4 pods, 100%)/15s` | geometric overshoot | big jumps take several periods |
| scale-down stabilization — HPA `300s` | downward overshoot, second storm | pay for peak 5 min longer |
| cooldown — ASG simple `300s` | flapping | one action per 5 min; 4× step = 20 min |
| instance warm-up — ASG `300s` | compounding orders | scale-in frozen; one step per warm-up |
| alarm datapoints — TT high 3 / low 15 | reacting to noise | +3 min dead time out, 15 min in |
| tolerance / dead band — HPA `0.1`, TT low at 90% | chatter | steady state anywhere in the band |
| lower target — 50% vs 80% | dead-time exposure | idle capacity, always |
| faster boot | shrinks dead time itself | engineering; warm pools are paid |
| `max` | runaway bill | designed outage at that load |

</div>

<div class="mt-3 text-sm">

**No controller covers all cases.** Dead time · sampling period · saturating signal · gain on the wrong base — every fix for one is a cost on another. Headroom is the only thing that works *inside* the dead time.

</div>

<div class="abs-br m-4 text-xs opacity-60">docs/controller-tradeoffs.md</div>

<!--
Bonus slide — dense on purpose, for photos. Full notes in docs/controller-tradeoffs.md.
-->
