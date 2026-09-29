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
[0.5 min] Cold open: play it straight, let the room nod along, then click for the laugh.
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
[1.5 min] Audience participation: ask the room what goes wrong, let answers land, don't rush the click.

A feedback loop adds failure modes that only exist because
the loop exists — oscillation, runaway, coupling. New categories, not more of the old ones.
Bullet → section map: bills → Cost Problem; cascades → Coupling/Unstable Units;
low utilization → Responsible (cost side); hard to tune → Control Theory.
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
[1.5 min] The max-scale ceiling exists regardless of the autoscaler — find it in
load tests, not in prod. Once max is known, autoscaling's only job is "don't run at max
when you don't have to" — cost optimization, not capacity engineering.
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
[5 min] The right signal (demand) is rarely available per-instance, so everyone
falls back to CPU/latency proxies — and the moment you scale on a symptom you've built a
closed feedback loop.

If you DID know per-server capacity, that's queueing theory (Little's Law);
nobody has it, and load is compressible anyway. War story to tell: a latency-scaled system
ran away to hundreds of instances while fixing nothing. This is the pivot into control theory.
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
[6 min] Framing first: continuous control (thermostat) vs discrete/sampled control —
everything here only sees the world every sync-period. Sims stand in for formal models
(these loops are too nonlinear for hand math).

Cue per bullet (don't read the slide):
1. Load moving faster than dead time = always chasing, structurally.
2. Gain: too high → oscillation; too low → never catches up.
3. Can't react faster than you sample or cooldown lets you — "just poll faster" isn't free (Nyquist-ish).
4. Stateless = fast but jumpy, double-orders in-flight capacity; memory (smoothing, integral,
   in-flight tracking) rides out noise but is slower. Most default autoscalers are stateless —
   k8s unready-pod set-aside is the exception.

Land: HPA/ASG knobs (sync-period, stabilization, cooldown, warm-up) are these same knobs,
just unnamed.
-->

---

# Oscillation, by Default

<Sim preset="cpu-oscillation" :expose="['baseRps', 'rps', 'algo', 'awsOutThreshold', 'awsInThreshold', 'awsCooldownSec', 'awsPeriodSec']" :height="130" />

<!--
Live DES from presets/cpu-oscillation.json. AWS simple scaling ±1, thresholds 0.55/0.45,
cooldown 0, 15s period vs 240s boot: +1 every 15s orders ~16 instances before one helps;
needed 3.5, swings 3<->20 all run (no count rests in the band). Demo: drag rps to 1360 —
7 instances sit at 49%, settles after one overshoot. QR = workbench, people can try it.
-->

---

# Hot, Cold, Hot, Cold...

<div class="cards">
  <div class="card">
    <div class="card-label">Patient</div>
    <div class="card-title">Nudge, then wait</div>
    <p class="card-body">Turn the hot tap a little. Wait for the pipe's dead time to actually pass before touching it again — the water already on its way has to arrive first. One or two nudges, dialed in.</p>
    <p class="card-note">time between adjustments ≫ pipe delay</p>
  </div>

  <div class="card card-symptom">
    <div class="card-label">Impatient</div>
    <div class="card-title">Turn, still cold, turn more</div>
    <p class="card-body">Crank it hotter — still feels cold, that water hasn't arrived yet. Crank hotter again. Then it all arrives at once, scalding, so you crank cold. Repeat forever.</p>
    <p class="card-note">time between adjustments ≈ pipe delay (or less)</p>
  </div>
</div>

<div class="takeaway">
  <div>The pipe's delay never changed. How often you touched the knob did.</div>
  <div class="punchline">Adjust <strong class="accent-takeaway">slower</strong> than the delay you're waiting on — or you're fighting your own last move.</div>
</div>

<!--
[2 min] Bridge to the AWS sim. Slide tells the story — just land the meta-point: the only
knob you control is your own adjustment interval, not the pipe. That's exactly the datapoint
period / metric delay lever on the next slide.
-->

---

# The Metric Pipeline Is Dead Time Too

<Sim preset="metric-delay-compare" :expose="['awsPeriodSec', 'awsMetricDelaySec', 'metricsResolutionSec', 'rps']" :height="130" />

<!--
Live DES from presets/metric-delay-compare.json. Flip period/delay live: AWS realistic
(60s/60s, dead time = period×3 + delay = 240s) vs fastest (10s/0s = 30s) — same 9x step,
same algorithm, same alarm rule. Numbers: first scale-out t=480s vs 325s; recovery t=1000s
vs 805s; errors 25.1% vs 18.8%. Controller math identical in both runs — only visibility
changed. Bonus demo: drag period below the 5s metric resolution and the alarm goes SILENT
(empty datapoints) — sampling can't outrun what it samples.
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
[4 min] Anchor story: an autoscaler overwhelmed the very DB it depended on — cascading failure.
Slide covers the mechanics; land the closer: fast-onset load beats any tuned loop —
headroom, not a smarter controller, is what survives it.
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
[3 min] CPU is honest in BOTH units and pins at 100% in
both, so the autoscaler lands on the same instance count either way. What differs is where
the overload goes during dead time: fast honest errors vs silent unbounded latency.
Tease: live demo next — flip "server profile", same pulse.
-->

---

# Tuned Threads vs. Node.js, Same Pulse

<Sim preset="pulse-compare-threaded-vs-event-loop" :expose="['serverProfile', 'workers', 'baseRps', 'rps', 'holdSec']" :height="130" />

<!--
Live DES from presets/pulse-compare-threaded-vs-event-loop.json. Flip "server profile"
live. Same 5x pulse (shorter than the 30s boot — no mid-pulse capacity can help); same
starting fleet; 70% CPU target on purpose — a well-behaved unit run HOT, not coasting.
Threaded tuned to 25 workers / queueSlots 0 (sweet spot: 15 sheds at steady state, 60 lets
p95 climb): 0% steady-state errors, p95 only ~165→210ms during the pulse, ~5.5% rejected
inside the burst. Event-loop: p95 ~82s, 6-7 min recovery, and still sheds ~8.7% — worse
than threaded on EVERY axis, including errors. Only variable: can the unit say no.
-->

---

# Scaling on Latency: The Trap

<Sim preset="latency-runaway" :expose="['metricLatencyTarget', 'dbPoolSlots', 'dbQueryMs']" :height="130" />

<!--
Live DES from presets/latency-runaway.json. Scaling on mean latency against a shared DB
pool that doesn't grow: ceiling = 8 slots / 30ms = 266.7 rps; load steps to 270rps — 1%
over, permanently. Numbers: latency ~58ms → ~3.3s, still climbing at end of run; instances
hit max (60) vs ~1.4 a CPU sizing would want; errors stay ~1% — a pure latency story.
Land it: the bottleneck was never compute, so adding compute fixes nothing — the same
queue with a bigger blast radius and bill.
-->

---

# The Thundering Herd

<Sim preset="thundering-herd" :expose="['clientTimeoutSec', 'clientMaxRetries', 'clientRetryDelaySec']" :height="130" />

<!--
Live DES from presets/thundering-herd.json — latency-runaway with ONE knob changed:
clientTimeoutSec 0 -> 3. Same DB ceiling (266.7rps), same 270rps step. At ~285s client
timeouts start firing; by ~310s OK throughput is at zero; by ~345s the fleet is pinned at
max (100) vs ~2 a CPU sizer would want. End state: 0 OK/s, ~220 retries/s sustained forever,
~88% client-visible errors. The autoscaler did exactly what its metric told it to and made
it worse — every added instance is just more clients hammering the same 8 DB slots.
Live flip: clientTimeoutSec 3 -> 5 on stage collapses the herd back to latency-runaway's
plain 1%-error trap — the timeout is the cliff, not a dial, and it's a knob we don't
control (external clients ship their own policy). Second point if time allows: a timed-out
attempt is abandoned client-side but NOT cancelled server-side — it keeps its worker/DB
slot until it finishes, so retries stack load instead of replacing it.
-->

---

# Scale-In That Bites Back

<Sim preset="db-outage-scalein" :expose="['faultDurationSec', 'dbPoolSlots', 'minInstances']" :height="130" />

<!--
Live DES from presets/db-outage-scalein.json. Healthy fleet of 6 (CPU-HPA, 8-slot shared DB
pool, 240rps under its 266.7rps ceiling). At t=600 the DB goes down for 600s — a fast, honest
failure (pool refuses connections, ~20ms in, before CPU ever runs). OK throughput hits 0,
errors run at the full 240/s. The trap: CPU utilization measures WORK DONE, and an outage is
defined by work NOT done — so the CPU-based scaler sees a starving fleet and, faithfully,
scales it IN. Fleet goes 6 -> 1 over 2-4 minutes, exactly backwards for what the situation
needs. When the DB recovers at t=1200, 240rps floods the single surviving pod: queues fill,
latency peaks ~900ms, and the climb back (1 -> 2 -> 4 -> 7, one HPA cadence at a time) takes
~10 minutes AND overshoots the original 6. ~28% total errors — most of them AFTER the DB was
already back. The outage ends; the incident doesn't.
Live flip: raise minInstances so the floor can't fall to 1 — same outage, same blind metric,
but the recovery herd shrinks because there's more standing capacity to absorb it.
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
[3 min] You don't control what drives your signal (retry storm,
scraper, attacker probing for exactly this); scaling's hidden costs (connections, egress,
log volume) don't show on the compute line. Land: `max` turns "a bill you didn't choose"
into "an outage you chose."
-->

---

# Buying Nothing, at Scale

<Sim preset="runaway-cost" :expose="['maxInstances', 'instancePriceHourly', 'extraCostRateHourly']" :height="130" />

<!--
Live DES from presets/runaway-cost.json — exactly "The Thundering Herd" (same DB-bound herd,
same 3s client timeout) with cost turned on: $0.10/instance-hour, plus a $50/hour surcharge
once the fleet crosses 20 instances (a DB tier upgrade / RDS proxy / NAT gateway that scales
with instance count, not with useful throughput). As saved (max 100, thundering-herd's own
default): fleet hits 100, ~$25 total spend, 87.9% errors.
Live flip #1: maxInstances 20 (right at the surcharge threshold) — IDENTICAL 87.9% errors,
same OK throughput, but $0.87 total. Every dollar above that bought nothing: the DB was
always the ceiling on real throughput, not instance count.
Live flip #2: maxInstances 100000 (no cap at all) — the fleet still finds its own equilibrium
around 125, not infinity (the metric feedback loop has its own fixed point) — but that
fixed point costs MORE than the deliberate 100-instance ceiling for the same 87.9% errors.
Land it: max isn't a safety net against overload here — the DB was always going to cap that.
It's a safety net against paying for the incident twice: once in errors, once on the bill.
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
[1 min] The organizational feedback loop, not the control one: paying for capacity removes
the pressure to fix the inefficiency. Feels like cost optimization vs peak provisioning —
but vs actually fixing the perf issue, it's usually not close. Comfortable beats cheap,
unless someone watches the per-request number.
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
[6 min] Callback slide — every bullet maps to an earlier section, nothing new; walk it as
a checklist. Dead time is physics — you can't out-tune it, only build headroom for it.
Slow and boring beats fast and wrong.
-->

---

# Same Load, Same Hostile Clients — Fixed

<Sim preset="the-fix" :expose="['minInstances', 'maxInstances', 'initialInstances']" :height="130" />

<!--
Live DES from presets/the-fix.json. SAME load as "Oscillation, by Default" (baseRps 300 ->
690, 240s boot) AND the same hostile clients as "The Thundering Herd" (3s timeout, 3 immediate
retries) — deliberately both earlier triggers at once. As saved: fixed fleet sized for peak
(min=max=initial=4) + bounded admission (40 workers / 10 queue slots, sheds fast instead of
queueing forever). Result: flat 100ms latency, 0% errors, zero retries ever fire — nothing
here ever gets slow enough to trip the 3s timeout, so the herd never gets a reason to start.
Live flip: minInstances 1, maxInstances 50, initialInstances 0 — puts a REAL, default-tuned
HPA on top instead of the fixed fleet (15s sync, 300s scale-down stabilization, capped
scale-up rate — none of cpu-oscillation's deliberately-terrible zero-cooldown setup). Starts
at 2 instances, one small bounded wobble during the step (~87% CPU for a single 15s tick,
one rejected request), settles at 4, then IDENTICAL to the fixed panel for the rest of the
run. Land it: a well-tuned scaler reaches the same stable answer as pre-sizing for peak —
the checklist on the previous slide isn't aspirational, this is what it looks like running.
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
[2 min] Full circle to What Could Possibly Go Wrong — the reframe was the point all along.
Land it, add nothing new.
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
