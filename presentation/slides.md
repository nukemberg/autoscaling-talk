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
duration: 30min
mdc: true
# Deployed slides; QR codes (<Qr path=…>) resolve against this.
baseUrl: https://autoscaling-talk.fewbytes.com
---

# Autoscaling
## Cost Optimization Turned Reliability Nightmare

Avishai Ish-Shalom

<div class="social">
  <a href="https://x.com/nukemberg" target="_blank"><XLogo /> @nukemberg</a>
</div>

<!--
Total budget: 27 min net content + 3 min buffer = 30 min total.
-->

---
layout: default
---

# We Love Autoscaling

<div class="content">

- Automagically handles extra load
- Makes server issues go away
- Simple, easy solution
- Advanced tooling widely available

</div>

<v-click>

<div class="abs-br m-4">
  <img src="/memes/putin-laughing.gif" class="meme" alt="Putin laughing meme">
</div>

</v-click>

<!--
[0.5 min]
Cold open, played straight — say each bullet like you mean it, let the
room nod along. Click to reveal the laugh. Nothing here is wrong per
se; it's the pitch everyone's heard, and it's also exactly what the
next 25 minutes complicates.
-->

---
layout: default
---

# What Could Possibly Go Wrong

<v-click>

<div class="content">

- Runaway bills
- Dynamic, cascading failures — escalating minor faults
- Low-utilization clusters
- Hard to tune — engineers fiddling with params forever

</div>

</v-click>

<!--
[1.5 min]
Audience-participation beat: ask the room. Let a few answers land
before clicking to reveal — most of what people shout out lands on
this list somewhere. Don't rush the click.

Verbal framing once the list is up (this used to be on-slide text,
now it's just said): static capacity fails in ways you can enumerate
ahead of time — it's either enough or it isn't. A feedback loop adds
failure modes that only exist because the loop exists: oscillation,
runaway, coupling to what it measures. Those are new categories, not
more of the old one. That's why surprise bills and cascading failures
are the norm rather than the exception, not bad luck.

Each bullet maps to a section: runaway bills → The Cost Problem,
cascading failures → Coupling and Blast Radius / Unstable Scaling
Units, low utilization → the cost side of Responsible Autoscaling,
hard to tune → Control Theory Crash Course.
-->

---
layout: default
---

# You're Not Scaling Up, You're Scaling Down

<div class="content">

- You design and load-test for max load — autoscaling or not
- Shared resources don't scale linearly (USL)
- You're scaling **down** from max, not up from min

</div>

<div class="takeaway">

Autoscaling is a **cost optimization**, not a scaleout solution.

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

# Scaling by Metrics, FTW! 🤦

<div class="cards">
  <div class="card">
    <div class="card-label">1. Demand (Cause)</div>
    <div class="card-title">What you want to scale on</div>
    <p class="card-body">Incoming work, queue depth</p>
    <p class="card-note">Hard to isolate per instance (LB distribution)</p>
  </div>

  <div class="card card-symptom">
    <div class="card-label">2. Symptoms (Effect)</div>
    <div class="card-title">What you actually have</div>
    <p class="card-body">CPU utilization, latency</p>
    <p class="card-note">Readily available proxies — but deceptive</p>
  </div>
</div>

<div class="takeaway">
  <div><strong class="accent-takeaway">3. Latency</strong> is an <em>effect</em>, not a capacity shortage.</div>
  <div class="punchline">When you scale on symptoms, you've built a closed feedback loop.</div>
</div>

<!--
[5 min]
Layout: two cards (Demand vs. Symptoms) + the 3-beat punchline at the bottom.

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

<div class="content">

- **Characteristic time vs. dead time** — how fast load moves vs. how long you take to react
- **Gain** — how hard you react to error
- **Discrete sampling** — can't react faster than you sample; cooldown is a second limit
- **Stateful vs. stateless controllers** — memory rides out momentary fluctuations, at the cost of speed and complexity

</div>

<div class="takeaway">

No control algorithm is perfect. There's **always** a tradeoff.

</div>

<div class="abs-br m-4">
  <Qr path="workbench/" :size="100" />
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

<Sim preset="cpu-oscillation" :expose="['baseRps', 'rps', 'algo', 'awsOutThreshold', 'awsInThreshold', 'awsCooldownSec', 'awsPeriodSec']" :height="130" />

<!--
Live DES from presets/cpu-oscillation.json (scenario sim/scenarios/cpu.ts).
AWS simple scaling ±1, thresholds 0.55/0.45, cooldown 0, 15s period —
every knob turned to "responsive". Sustained flapping, by design:
+1 every 15s against a 240s boot orders ~16 instances before the first
one helps, and at 690 rps there's no count to rest at (3 instances =
58%, 4 = 43% — the band is narrower than one instance). Needed 3.5;
it swings 3 <-> 20 for the whole run. Drag rps to 1360 and 7 instances
land at 49% inside the band: one overshoot, then it settles. Tune
in the workbench (npm run bench), export JSON. QR points at the
deployed SimCluster workbench so people can try it themselves.
-->

---
layout: default
---

# Coupling and Blast Radius

<div class="content">

- N instances = **N× connection pools** on the same upstream — not just more capacity
- LB registration + health checks are dead time too — new instances aren't helping yet
- Recovery is a **herd** — everything reconnects at once
- Fast-onset load beats any scaler whose dead time > onset time. No controller fixes that.

</div>

<!--
[4 min]
Autoscaler overwhelmed the very database it depended on and triggered a
cascading failure. How scaling couples to upstream dependencies, the load
balancer, and fast-onset load.

Scaling out doesn't just add compute — it multiplies whatever each
instance holds open against a shared dependency (DB connections, cache
clients, outbound sockets). The database didn't get more capacity when
the app did; it got hit harder. LB registration delay and health-check
grace periods are dead time on the way *in*, same physics as boot time,
just usually smaller and ignored. And when something recovers —
upstream comes back, instances pass health checks again — everything
that was waiting fires at once: a self-inflicted thundering herd.
Fast-onset load (viral post, cache stampede, flash sale) can move
faster than dead time + reaction time no matter how well-tuned the
loop is — headroom, not a smarter controller, is what survives it.
-->

---
layout: default
---

# Unstable Scaling Units

<div class="content">

- **Well-behaved unit** — bounded workers = admission control: sheds fast when full, predictable capacity, bounded latency, boots fast, honest metrics
- **Bad unit** — never says no: an unbounded worker pool admits everything, then queues it all on the same finite CPU

</div>

<div class="takeaway">

A unit that can't reject still runs out of CPU — it just fails as latency instead of errors.

</div>

<!--
[3 min]
Degrade vs. reject: what happens when a scaling unit is overloaded but
still gets traffic. Why unstable units make every other problem worse.

Loss (Erlang-B, reject when full) is the well-behaved case — bounded
workers are admission control: past capacity a request is rejected
immediately and visibly, and everything that IS admitted keeps a
predictable, bounded latency. A degrading unit (Node.js-style unlimited
concurrency, or an unbounded thread/worker pool) never rejects — but
never rejecting doesn't add capacity. The CPU is exactly as finite as
before, so the overload turns into a queue for a core: every request
gets slower, the backlog grows for as long as the autoscaler's dead
time lasts, and it keeps draining long after new capacity arrives.
The metric isn't the difference: CPU is honest in both units, and it
pins at 100% in both (so neither can tell 10% over from 10x over), so
the autoscaler reacts the same way and lands on the same instance
count. What differs is where the overload goes during the dead time —
fast, honest failures vs. silent, unbounded waits. Zero errors on the
dashboard, a minute of latency for the user.
Live demo on the next slide: flip "unlimited workers", same input, same knobs.
-->

---

# Bounded Workers vs. Unlimited Workers

<Sim preset="unit-model-compare" :expose="['unlimitedWorkers', 'workers', 'cores', 'cpuTimeMs', 'queueSlots']" :height="130" />

<!--
Live DES from presets/unit-model-compare.json. Sine-wave load (period
200s) so the unit sees sustained variation, not just one step. Flip
"unlimited workers" off to on live: same input, same knobs. Off, the
per-instance worker pool is the explicit workers knob (10 slots here,
plus 8 queue slots) and acts as real admission control — it
rejects past capacity, cleanly and immediately: ~3% errors, all of
them during the scale-out dead time, and latency stays bounded (max
~260ms, mean ~155ms across the run). On, workers never reject — but
the CPU pool (2 cores) still saturates for real, so requests that
used to get a fast, honest rejection now just queue for a core
instead: errors drop to 0%, but mean latency jumps to ~4.6s (~30x
worse) and worst-case latency spikes to ~65 SECONDS. Instance count
is nearly identical either way (bounded settles at 12, exactly the
needed 12; unlimited settles one higher, at 13): "cpu" is an honest,
time-averaged busy fraction of the real CPU pool in both variants, and
it pins at 100% during the overload in both. The one real wrinkle:
HPA reads the single latest scrape, not a smoothed average — same as
real HPA, which doesn't average history itself — so it's more exposed
to short spikes; unlimited's longer 100%-pinned stretch (the backlog
still draining after capacity arrives) is enough to catch one extra
sync tick still-saturated and add one instance the bounded case never
needed. Watch the cpu line: unlimited stays pinned at 100% noticeably
longer — that's the backlog draining. Instance count is *almost* not
the story here (unlike "the bad unit ends up much bigger" — it barely
does); where the overload goes is the real story. Zero errors looks
like success on a dashboard that only tracks error rate — it isn't.
-->

---
layout: default
---

# The Cost Problem

<div class="content">

- Autoscaling means **someone else controls your bill** — retry storms, scrapers, a bug in a client
- Scaling costs your upstream too — DB tiers, egress, per-connection pricing
- Scaling is an attack surface — economic DoS
- **Always set `max`.** It's the rate limit on your own wallet.

</div>

<div class="abs-br m-4">
  <img src="/memes/agent-hpa-license-to-spend.jpeg" class="meme" alt="James Bond-style 'Agent HPA: License to Spend' meme">
</div>

<!--
[3 min]
External actors, runaway upstream costs, no max. Autoscaling optimizes
cost until it doesn't — the failure mode nobody budgets for.

You don't control what drives your scaling signal — a retry storm, a
scraper, a misbehaving client, an external actor probing for exactly
this. Scaling out isn't free even when it "works": every new instance
is more connections, more egress, more log volume, more load on
whatever it depends on — costs that don't show up in the compute bill
line. Without `max`, autoscaling has no ceiling: an attacker (or a bug)
that can drive your load can drive your spend, unbounded. `max` isn't
a nice-to-have, it's the one knob that turns "runaway" into "an outage
you chose" instead of "a bill you didn't."
-->

---
layout: image-right
image: /memes/drake-autoscaling.jpg
backgroundSize: contain
---

# Comfortable Patch

<div class="content">

- Autoscaling absorbs perf problems painlessly — so nothing forces you to actually fix them
- You're not reducing cost **per request**. You're paying for more capacity, forever.

</div>

<div class="takeaway">

You are reducing per-request cost, right?

**Right??**

</div>

<!--
[1 min]
The engineering feedback loop, not the control one: autoscaling makes
a capacity problem invisible by paying for it automatically, which
removes the organizational pressure that would otherwise force someone
to fix the actual inefficiency. It feels like cost optimization
because the bill per request looks flat or even improves relative to
peak provisioning — but compare it to what fixing the underlying
perf issue would have cost, and it's usually not close. Comfortable
beats cheap, every time, unless someone's watching the per-request
number specifically.
-->

---
layout: default
---

# Responsible Autoscaling

<div class="content">

- Design for max scale first. Load-test it. Autoscaling is cost, not capacity.
- Well-behaved units — bounded, shed fast, honest metrics
- A signal that actually tracks load
- Tune the loop **on purpose**. Slow is fine.
- Protect upstream. Set `max`.

</div>

<div class="takeaway">

The real fix is often **less** autoscaling: warm headroom, load shedding, backpressure.

</div>

<!--
[6 min]
Design for max scale first, keep scaling units well-behaved, pick a
signal that tracks load, tune the loop, protect upstream. The real fix
is often less autoscaling: warm headroom, load shedding, backpressure.

This is the callback slide — every bullet maps to a section: Design
for Max, Unstable Scaling Units, Scaling by Metrics, Control Theory
Crash Course, Coupling and Blast Radius / The Cost Problem. Nothing
here is new; it's the same five ideas restated as a checklist. "Tune
the loop on purpose" — slow and boring beats fast and wrong; dead time
is physics, you can't out-tune it, only build headroom for it.
-->

---
layout: default
---

# Summary

<div class="content">

Autoscaling is a cost optimization with a feedback loop attached — and every feedback loop has failure modes the static version didn't.

**Simpler is often better. Don't run before you walk.**

</div>

<!--
[2 min]
Simpler is often better. Don't run before you walk.

Full circle to What Could Possibly Go Wrong: the reframe was the
point all along. Land on it, don't add anything new here.
-->

---
layout: center
class: text-center
---

# Thank You

Questions?

<div class="mt-6">
  <Qr path="" :size="140" />
</div>

<div class="social">
  <a href="https://x.com/nukemberg" target="_blank"><XLogo /> @nukemberg</a>
</div>

---
layout: default
class: tradeoffs
---

# Bonus: every knob is a trade

<div class="tradeoffs">

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

<div class="tradeoffs-note">

**No controller covers all cases.** Dead time · sampling period · saturating signal · gain on the wrong base — every fix for one is a cost on another. Headroom is the only thing that works *inside* the dead time.

</div>

<div class="abs-br m-4">
  <Qr path="docs/controller-tradeoffs.md" :size="120" />
</div>

<!--
Bonus slide — dense on purpose, for photos. Full notes in docs/controller-tradeoffs.md.
-->
