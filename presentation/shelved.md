# Shelved slides

Slides pulled from the deck for time — re-add when there's room.
Copy a block (including its leading `---` separator) back into `slides.md`.

---

# Round Robin vs. Least Connections

<Sim preset="lb-policy-compare" :expose="['lbPolicy', 'rps', 'cpuTimeMsSigma', 'workers', 'queueSlots']" :height="130" />

<!--
Live DES from presets/lb-policy-compare.json. Flip "LB policy" live; fixed 3 instances,
no autoscaler — pure routing, not scaling. Heavy-tailed service times (lognormal, median
20ms, sigma 1.5); tight workers/queue so slow requests back up their instance.
Measured (seeds 1-5): RR ~490ms mean / ~1.3s p95 / ~8.5% rejected; LC ~330-365ms mean /
~0.9s p95 / ~5-6.5% rejected — ~30% better tails, same load, same fleet. RR is fair by
count, not by cost. Demo: drag cpuTimeMsSigma → 0 and the policies converge.
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

# One Client, No Attack, No Bug On Your Side

<Sim preset="external-actor" :expose="['scraperRps', 'scraperStartSec', 'maxInstances']" :height="130" />

<!--
Live DES from presets/external-actor.json. Organic demand is FLAT the whole run (100rps,
never changes). At t=300 a single external actor — scraper, bot, or a client stuck retrying
— starts at 800rps, mixed into the exact same requests real users send; nothing server-side
can tell them apart. Measured: fleet climbs 1 -> 5, cost climbs 40x over the run — but
"useful" throughput (total OK minus the tagged actor traffic, a line only this sim can draw)
never moves off ~90-105rps the entire time, before, during, and after.
Live flip: scraperRps back to 0 — flat fleet, flat cost, for the identical organic demand.
Land it: the autoscaler isn't broken here — it's doing exactly what a utilization signal is
FOR. The signal can't tell "more real users" from "one client that won't stop," and neither,
usually, can a real dashboard.
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
