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
