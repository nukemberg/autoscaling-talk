---
theme: default
title: 'Autoscaling: Cost Optimization Turned Reliability Nightmare'
info: |
  ## Autoscaling: Cost Optimization Turned Reliability Nightmare
  Reversim 2026
class: text-center title-slide
layout: center
drawings:
  persist: false
transition: slide-left
comark: true
duration: 30min
mdc: true
# Deployed slides; QR codes (<Qr path=…>) resolve against this.
baseUrl: https://autoscaling-rant.fewbytes.com
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

- Absorbs extra load
- Makes server issues vanish
- Simple
- Tooling everywhere

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
- Cascading failures
- Idle clusters
- Endless tuning

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

# You Think You're Scaling Up. You're Scaling Down.

<div class="content">

- You load-test for **max** — autoscaling or not
- Shared resources don't scale linearly
- You scale **down** from max, not up from min

</div>

<div class="takeaway">

Autoscaling is **cost optimization**, not scaleout.

</div>

<!--
[1.5 min] The max-scale ceiling exists regardless of the autoscaler — find it in
load tests, not in prod. Once max is known, autoscaling's only job is "don't run at max
when you don't have to" — cost optimization, not capacity engineering.
Treat it as scaleout, and you find out in prod you can't actually scale.
-->

---
class: sim
---

# A Cost Optimization That Didn't

<CostCompare preset="overshoot-cost" :static-instances="7" />

<!--
Live DES from presets/overshoot-cost.json, run twice, stacked top/bottom on the same y-axis
bounds (CostCompare.vue): once autoscaled, once with min=max=initial pinned to 7 — the
exact count the autoscaler itself converges to, not hindsight. Same load (flat 2
instances/50%/0 errors for 300s, then a step to 1360rps) on both. Top: zero cooldown + 15s
period ordering blind for the full 240s boot climbs to 23 instances (~t=620, well over 3x
the 7 actually needed) before walking back down, with 16.3% errors during the climb — the
overshoot didn't even buy better service. Bottom: flat line, the whole run — same axis, so
the overshoot's height reads directly against it.

The big number is the punchline: $0.76 autoscaled vs $0.23 static over this exact 900s
window — 3.3x (cost accounting starts at the pre-horizon boot/health-check warmup, so the
static side isn't simply 7 × 900s by hand either — both sides pay for their initial fleet
booting). That ratio falls the longer the window runs past the recovery (2.6x by 1500s,
2.0x by 2400s) as the one-time overshoot amortizes — not "autoscaling always costs more,"
just that a controller's mistake is a real, measurable dollar cost.

Land: this is the same aws-simple setup as the oscillation slide coming up — same dead
time, same missing anti-windup, just a baseline/step that both happen to land inside the
band so it overshoots once instead of flapping forever. The "cost optimization" from the
last slide isn't automatic; a controller that reacts without accounting for its own
pending orders can spend MORE than no autoscaler at all.
-->

---
layout: default
---

# Scaling by Metrics, FTW! 🤦

<div class="cards">
  <div class="card">
    <div class="card-label">Cause</div>
    <div class="card-title">Demand</div>
    <p class="card-body">Incoming work, queue depth</p>
    <p class="card-note">Hard to measure per instance</p>
  </div>

  <div class="card card-symptom">
    <div class="card-label">Effect</div>
    <div class="card-title">Symptoms</div>
    <p class="card-body">CPU, latency</p>
    <p class="card-note">Easy to get. Deceptive.</p>
  </div>
</div>

<div class="takeaway">
  <div><strong class="accent-takeaway">Latency</strong> is an effect, not a capacity shortage.</div>
  <div class="punchline">Demand = feedforward. Symptoms = feedback on the wrong variable.</div>
</div>

<!--
[5 min] The right signal (demand) is rarely available per-instance, so everyone
falls back to CPU/latency proxies. Scaling on demand is feedforward (size for the arrival
rate). Scaling on a symptom is feedback on a confounded signal: an upstream slowdown raises
latency, which adds instances to the wrong resource, which can run away.

If you DID know per-server capacity, that's queueing theory (Little's Law);
nobody has it, and load is compressible anyway. War story up next: a latency-scaled system
ran away to hundreds of instances while fixing nothing.
-->

---
layout: center
class: statement
clicks: 3
---

# War Story: The Latency Trap

<LatencyFunnel :step="$clicks" />

<style>
/* Compact title so the diagram + final caption keep a safe bottom margin. */
.slidev-layout.statement h1 { font-size: 1rem; margin-bottom: 0.5rem; }
</style>

<!--
[1 min] Service's response time crept up during a routine
traffic bump. The autoscaler's trigger was mean latency, not CPU — so it did exactly what
it was configured to do and scaled out. Every new instance opened more connections to the
same shared database, whose connection pool was the actual bottleneck and didn't grow with
the fleet. Latency kept climbing regardless, so the autoscaler kept adding instances — all
the way to the configured max, hundreds of them, no capacity gained, nothing fixed.

The promised payoff of the previous slide's "war story to tell" tease. Keep it short — the
sim on the next slide is the receipts. Land: this is the symptom-scaling feedback loop from
"Scaling by Metrics" one slide back, now with a body count.
-->

---
class: sim
---

# Scaling on Latency: The Trap

<Sim preset="latency-runaway" :expose="['metricLatencyTarget', 'dbPoolSlots', 'dbQueryMs']" :charts="['instances', 'req/s', 'ms']" :hide-series="['usefulRps', 'retriedRps', 'inRotation']" :summary-keys="['errors %']" />

<!--
Live DES from presets/latency-runaway.json. Scaling on mean latency against a shared DB
pool that doesn't grow: ceiling = 8 slots / 30ms = 266.7 rps; load steps to 270rps — 1%
over, permanently. Numbers: latency ~58ms → ~3.3s, still climbing at end of run; instances
hit max (60) vs ~1.4 a CPU sizing would want; errors stay ~1% — a pure latency story.
Land it: the bottleneck was never compute, so adding compute fixes nothing — the same
queue with a bigger blast radius and bill.
-->

---
layout: center
class: statement
---

# Control Theory Crash Course

<div class="big">

Dead time · Gain · Visibility

</div>

<div class="abs-br m-4">
  <Qr path="workbench/" :size="100" />
</div>

<!--
[0.5 min] Framing first: continuous control (thermostat) vs discrete/sampled control —
everything here only sees the world every sync-period. Sims stand in for formal models
(these loops are too nonlinear for hand math). QR = workbench, people can play along.

Land at the end of the section: HPA/ASG knobs (sync-period, stabilization, cooldown,
warm-up) are these same three ideas (dead time, gain, visibility), just unnamed.
-->

---
layout: default
---

# Dead Time

<div class="stages">
  <div class="card card-symptom">
    <div class="card-label">Sensing</div>
    <div class="card-title">See it</div>
    <p class="card-body">Metrics lag</p>
  </div>
  <div class="arrow">→</div>
  <div class="card card-symptom">
    <div class="card-label">Decision</div>
    <div class="card-title">Decide</div>
    <p class="card-body">Sync period, cooldown</p>
  </div>
  <div class="arrow">→</div>
  <div class="card card-symptom">
    <div class="card-label">Actuation</div>
    <div class="card-title">Do it</div>
    <p class="card-body">Boot, health checks, LB</p>
  </div>
</div>

<div class="total"><span>dead time</span></div>

<div class="takeaway">
  <div>Can't track anything <strong class="accent-takeaway">faster</strong> than this.</div>
</div>

<style>
.slidev-layout .stages { display: grid; grid-template-columns: 1fr auto 1fr auto 1fr; align-items: center; gap: 0.75rem; margin-top: 1rem; }
.slidev-layout .stages .card { padding: 1rem 1.25rem; height: 100%; box-sizing: border-box; }
.slidev-layout .stages .card-title { font-size: 1.9rem; white-space: nowrap; }
.slidev-layout .stages .card-body { font-size: 1.25rem; }
.slidev-layout .stages .arrow { font-size: 2.2rem; font-weight: 800; color: var(--c-symptom); }
/* bracket under the three stages: their sum is the dead time */
.slidev-layout .total { margin-top: 0.6rem; border: 4px solid var(--c-symptom); border-top: none; border-radius: 0 0 0.75rem 0.75rem; height: 1rem; position: relative; }
.slidev-layout .total span { position: absolute; left: 50%; top: 0.35rem; transform: translateX(-50%); background: var(--slidev-theme-background, #fff); padding: 0.1rem 0.8rem; font-size: 1.5rem; font-weight: 800; color: var(--c-symptom); }
.slidev-layout .takeaway { margin-top: 2.25rem; margin-bottom: 2rem; }
</style>

<!--
[1.5 min] Dead time = the silence between "load changed" and "capacity is serving it".
Three sources, left to right: sensing (metrics have to be collected, aggregated, delivered
— CloudWatch delay, datapoint period x N alarm evaluations), decision (sync period,
cooldown, stabilization window), actuation (API call, boot, health checks, LB
registration). The sum is the dead time.

Why it hurts: until capacity arrives you're short, and nothing the controller does shortens
that. If load moves faster than the dead time, capacity arrives for a world that's already
gone — short while load is up, wasted after it's down. Always chasing. Foreshadow: the
oscillation sim is exactly this with a fast controller on top.

Visibility feeds it: coarse resolution and long windows add to the sensing/decision
segments (a window average delays the signal by about half the window).
-->

---
layout: default
---

# Gain

<div class="cards">
  <div class="card amber">
    <div class="card-label">Too high</div>
    <div class="card-title">Oscillation</div>
    <p class="card-body">Overshoots, swings back, overshoots again.</p>
  </div>

  <div class="card amber">
    <div class="card-label">Too low</div>
    <div class="card-title">Never catches up</div>
    <p class="card-body">Safe, stable, and always behind.</p>
  </div>
</div>

<div class="takeaway">
  <div>How hard you react <strong class="accent-takeaway">is a dial</strong>, not a default.</div>
</div>

<style>
.slidev-layout .card.amber { --card-accent: var(--c-takeaway); }
</style>

<!--
[1 min] Gain = how big a correction per unit of error. Too high → oscillation; too low →
never catches up. No setting is right for every load; this is the knob everyone leaves at
its default.
-->

---
layout: default
---

# Visibility

<div class="cards">
  <div class="card amber">
    <div class="card-label">Resolution</div>
    <div class="card-title">How often</div>
    <p class="card-body">You can't react faster than you look.</p>
  </div>

  <div class="card amber">
    <div class="card-label">Window</div>
    <div class="card-title">How far back</div>
    <p class="card-body">Short window: jumpy. Long window: slow.</p>
  </div>
</div>

<div class="takeaway">
  <div>You only ever see <strong class="accent-takeaway">a slice of the past</strong>.</div>
</div>

<style>
.slidev-layout .card.amber { --card-accent: var(--c-takeaway); }
</style>

<!--
[2 min] Everything the controller knows is a slice of the past, and the slice has two
dials.

Resolution — how often and how finely you look (sync period, cooldown, metric datapoint
period). Can't react faster than you sample; "just poll faster" costs money and noise, and
below the metric's own resolution it just returns empty datapoints (the metric-pipeline sim
has a bonus demo of exactly this).

Window — how far back you look. "Now" isn't a point: one sample, a 1-minute average, a
5-minute average. Short window = fast but jumpy, and it double-orders capacity that's
already booting because the last order hasn't shown up in the numbers yet. Long window =
smooth but slow — you act on a world that's already moved on.

Prediction is the far end of the window dial: guess the future from the past (smoothing,
integral term, forecasts, tracking in-flight capacity). Works only while the future looks
like the past. Most default autoscalers are stateless — latest window only; k8s set-aside
of unready pods is the exception.
-->

---
layout: center
class: statement
---

# The Catch

<div class="big">

No controller is perfect.

<span class="sub">**Always** a tradeoff.</span>

</div>

<!--
[0.5 min] The section's one-line takeaway. Next: the oscillation sim — dead time and gain
together.
-->

---
class: sim
---

# Oscillation, by Default

<Sim preset="cpu-oscillation" :expose="['baseRps', 'rps', 'algo', 'awsOutThreshold', 'awsInThreshold', 'awsCooldownSec', 'awsPeriodSec']" :charts="['instances']" :summary-keys="['errors %']" />

<!--
War story (payoff for the control-system pivot flagged in AGENTS.md's outline): a
CPU-triggered autoscaler, tuned for a fast reaction, had a sync period far shorter than
boot time — so every cycle without immediate relief ordered another batch of instances
before the last batch had even finished starting. Utilization swung from pegged to
starved and back as oversized batches landed all at once, and on every down-swing the
scale-in policy killed youngest-first — the instances still booting, the ones that had
never served a single request. The cluster spent real money cycling capacity that existed
only on paper. Dead time doesn't forgive a fast loop; it punishes it.

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
    <p class="card-body">Let the water already in the pipe arrive. Dialed in.</p>
    <p class="card-note">adjust interval ≫ pipe delay</p>
  </div>

  <div class="card card-symptom">
    <div class="card-label">Impatient</div>
    <div class="card-title">Still cold? Turn more.</div>
    <p class="card-body">It all arrives at once. Scalding. Repeat forever.</p>
    <p class="card-note">adjust interval ≪ pipe delay</p>
  </div>
</div>

<div class="abs-tr m-4 play">
  <a :href="`${$slidev.configs.baseUrl}/shower/`" target="_blank" rel="noopener">Play it ↗</a>
  <Qr path="shower/" :size="90" :label="false" />
</div>

<div class="takeaway">
  <div>Adjust <strong class="accent-takeaway">slower</strong> than the delay you're waiting on.</div>
  <div class="punchline">… or you fight your own last move.</div>
</div>

<style>
/* Tighter cards so the takeaway clears the bottom edge (projector/recording safe area). */
.slidev-layout .cards { margin-top: 1rem; gap: 1.25rem; }
.slidev-layout .card { padding: 1rem 1.25rem; }
.slidev-layout .card-title { font-size: 1.8rem; white-space: nowrap; }
.slidev-layout .card-body { font-size: 1.3rem; }
.slidev-layout .card-note { margin-top: 0.6rem; }
.slidev-layout .takeaway { margin-top: 1.25rem; margin-bottom: 2.5rem; }
.slidev-layout .play { display: flex; align-items: center; gap: 0.6rem; }
.slidev-layout .play a { font-size: 1.3rem; font-weight: 800; color: var(--c-takeaway); text-decoration: none; border-bottom: none; white-space: nowrap; }
</style>

<!--
[2 min] Play it live first: you take the shower (pick a delay, overshoot on purpose), then QR for the room — everyone plays solo on their phone, no backend. Then bridge to the AWS sim. Slide tells the story — just land the meta-point: the only
knob you control is your own adjustment interval, not the pipe. That's exactly the datapoint
period / metric delay lever on the next slide.
-->

---
class: sim
---

# The Metric Pipeline Is Dead Time Too

<Sim preset="metric-delay-compare" :expose="['awsPeriodSec', 'awsMetricDelaySec', 'metricsResolutionSec', 'rps']" :charts="['instances', 'req/s']" :hide-series="['usefulRps', 'retriedRps', 'inRotation']" :summary-keys="['errors %']" :bands="[{ from: 1000, to: 1400, label: 'System OK, but\nstill scaling up' }]" />

<!--
Live DES from presets/metric-delay-compare.json. Flip period/delay live: AWS realistic
(60s/60s, dead time = period×3 + delay = 240s) vs fastest (10s/0s = 30s) — same 9x step,
same algorithm, same alarm rule. Numbers: first scale-out t=480s vs 325s; recovery t=1000s
vs 805s; errors 25.1% vs 18.8%. Controller math identical in both runs — only visibility
changed. Bonus demo: drag period below the 5s metric resolution and the alarm goes SILENT
(empty datapoints) — sampling can't outrun what it samples.
-->

---
layout: center
class: statement
clicks: 4
---

# War Story: The Autoscaler Ate the Database

<DbBlastRadius :step="$clicks" />

<style>
/* Compact title so the diagram + final caption keep a safe bottom margin. */
.slidev-layout.statement h1 { font-size: 1rem; margin-bottom: 0.5rem; }
</style>

<!--
[1 min] Load spike triggered a scale-out, and the fleet grew
well past its usual size within minutes. Nobody had sized the database for that fleet —
each instance opened its own connection pool, and the sum of all those pools blew past the
database's connection limit. The database fell over under connection overhead alone, every
instance lost its queries, and clients retried immediately. When the database came back,
every instance reconnected at once — the exact same spike, self-inflicted, on a system
already running on fumes.

Payoff for AGENTS.md's [6 min] "coupling and blast radius" beat: an autoscaler overwhelmed
the very database it depended on and triggered a cascading failure. Land: this is the
mechanics on the next slide — N instances = N connection pools, recovery is a herd.
-->

---
layout: default
---

# Coupling and Blast Radius

<div class="content">

- **×N** instances = **×N** connection pools
- New instances start **cold**: caches, pools, JIT
- Recovery exhibits **herd behavior**
- Fast-onset load beats any controller

</div>

<!--
[4 min] Anchor story: an autoscaler overwhelmed the very DB it depended on — cascading failure.
Slide covers the mechanics (cold starts: new instances hit the DB hardest, before caches warm); land the closer: fast-onset load beats any tuned loop —
headroom, not a smarter controller, is what survives it.
-->

---
layout: default
---

# Unstable Scaling Units

<div class="content">

<div class="cards">
  <div class="card">
    <div class="card-label">Well-behaved</div>
    <div class="card-title">Bounded workers</div>
    <p class="card-body">Says no when full. Fails fast.</p>
  </div>
  <div class="card card-symptom">
    <div class="card-label">Bad</div>
    <div class="card-title">Never says no</div>
    <p class="card-body">Queues everything on the same CPU.</p>
  </div>
</div>

</div>

<div class="takeaway">

A unit that can't reject fails as **latency**, not errors.

</div>

<!--
[3 min] CPU is honest in BOTH units and pins at 100% in
both, so the autoscaler lands on the same instance count either way. What differs is where
the overload goes during dead time: fast honest errors vs silent unbounded latency.
Tease: live demo next — flip "server profile", same pulse.
-->

---
class: sim
---

# Same Pulse, Tuned Threads

<Sim preset="pulse-compare-threaded-vs-event-loop" :expose="['workers', 'baseRps', 'rps', 'holdSec']" :charts="['instances', 'req/s', 'ms']" :hide-series="['usefulRps', 'retriedRps', 'inRotation']" :summary-keys="['errors %']" />

<!--
Live DES from presets/pulse-compare-threaded-vs-event-loop.json, threaded profile. 5x pulse
(shorter than the 30s boot — no mid-pulse capacity can help); 70% CPU target on purpose — a
well-behaved unit run HOT, not coasting. Tuned to 25 workers / queueSlots 0 (sweet spot: 15
sheds at steady state, 60 lets p95 climb): 0% steady-state errors, p95 only ~165→210ms during
the pulse, ~5.5% rejected inside the burst. Setup for the next slide: same pulse, same
fleet, only the unit changes.
-->

---
class: sim
---

# Same Pulse, Node.js

<Sim preset="pulse-compare-threaded-vs-event-loop" :params="{ serverProfile: 'event-loop', unlimitedWorkers: true, cores: 1, queueSlots: 0, dbPoolSlots: 0, initialInstances: 16, maxInstances: 80 }" :expose="['baseRps', 'rps', 'holdSec']" :charts="['instances', 'req/s', 'ms']" :hide-series="['usefulRps', 'retriedRps', 'inRotation']" :summary-keys="['errors %']" />

<!--
Same preset, serverProfile=event-loop (unbounded workers), single-core processes. Equal
hardware: 16 one-core Node processes (initialInstances 16) vs 4 four-core threaded boxes —
same 16 cores, same ~70% base CPU, p95 ~175-210ms before the pulse. Clients/LB give up after
30s (clientTimeoutSec, both slides). Pulse: queue builds, waits blow past 30s, ~6% of requests
time out (threaded: ~5.3% rejected — similar rate!). The difference is HOW: threaded says no in
milliseconds; Node says no after 30s of waiting, and the abandoned work still burns CPU, so
the drain still takes ~3 min. Memory isn't modelled. Flip back to
the previous slide to compare. Only variable: can the unit say no.
-->

---
layout: default
---

# The Cost Problem

<div class="content">

- **Someone else** controls your bill
- Scaling costs your upstream too
- Scaling is an attack surface
- **Always** set `max`.

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
layout: image-right
class: bottom-margin
image: /memes/drake-autoscaling.jpg
backgroundSize: contain
---

# Comfortable Patch

<style>
.content li { font-size: 0.92em; }
.takeaway { font-size: 0.92em; }
</style>

<div class="content">

- Autoscaling hides perf problems
- You pay for more capacity. **Forever.**

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

- Load-test **max** first
- Well-behaved units
- A signal that tracks load
- Tune **on purpose** — slow is fine
- Protect upstream. Set `max`.

</div>

<div class="takeaway">

Often the fix is **less** autoscaling: headroom, shedding, backpressure.

</div>

<!--
[6 min] Callback slide — every bullet maps to an earlier section, nothing new; walk it as
a checklist. Dead time is physics — you can't out-tune it, only build headroom for it.
Slow and boring beats fast and wrong.
-->

---
layout: center
class: statement
---

# Summary

<div class="big">

A cost optimization with a **feedback loop** attached.

<span class="sub">Default to static.<br>Autoscale when it pays for its own complexity.</span>

</div>

<!--
[2 min] Full circle to What Could Possibly Go Wrong — the reframe was the point all along.
Land it, add nothing new.

Thesis: static is the default. Autoscaling has to earn its place. It earns it when:
1. You understand the ramifications.
2. The tradeoffs justify the complexity and failure modes — enough scale (no point saving
   $20/month on a system that makes $10,000/month), enough traffic variability, a mature system.
3. You have proper monitoring.
4. You have good scaling signals.
5. The scaling units are well behaved.
(...and more — the point is the test, not the list.)
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

<div class="abs-tr m-4">
  <Qr url="https://github.com/nukemberg/autoscaling-talk/blob/master/docs/controller-tradeoffs.md" :size="90" :label="false" />
</div>

<!--
Bonus slide — dense on purpose, for photos. Full notes in docs/controller-tradeoffs.md.
-->
