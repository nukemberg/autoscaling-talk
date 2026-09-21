# Autoscaler control tradeoffs

Working notes for the talk and for building the simulations. Every knob that
removes one failure mode buys another one. There is no setting that is right
for all load shapes — pick the failure you can live with.

## The four things you can't tune away

| Constraint | Where it comes from | What it costs you |
|---|---|---|
| **Dead time D** | boot + health-check registration + metric pipeline lag | Nothing you do inside the loop reacts faster than D. Any load change whose onset is shorter than D is served by whatever capacity you already had. |
| **Sampling period T** | HPA sync 15 s, CloudWatch 60 s datapoints | Controller can't see anything shorter than ~2T. Load bursts between samples are invisible. |
| **Saturating signal** | CPU clips at 100 %, slots clip at concurrency | Above the clip the controller can't tell 1.2× overload from 10×. It scales in fixed steps until the signal comes back into range — or scales on garbage while instances are hung. |
| **Gain applied to the wrong base** | proportional policy multiplies whatever it thinks "current" is | If "current" includes capacity that isn't serving yet, every period compounds the order. Every real controller has a rule for this (HPA: set-aside unready pods; AWS: instance warm-up). Turn it off and you get the geometric storm. |

Corollary: any controller ticking faster than D, on a lagging saturated
signal, without knowledge of its own pending actions, overshoots. That is not
a bug in a product; it is what feedback with delay does.

## Knobs, and what each one trades

| Knob | Real-world name | Removes | Costs | Sim evidence |
|---|---|---|---|---|
| Scale-up rate limit | HPA `scaleUp.policies` max(4 pods, 100 %)/15 s | geometric overshoot | reaching a big jump takes several periods → longer under-capacity | HPA on 100→400 rps step: 2→4→6, peak 6, needed 5 |
| Scale-down stabilization | HPA `stabilizationWindowSeconds: 300` | downward overshoot → second storm | pay for peak capacity 5 more minutes after every spike | — |
| Cooldown | AWS simple scaling `Cooldown: 300` | flapping | exactly one action per 5 min; a 4× step needs 4 cooldowns = 20 min at ±1 | `cpu-oscillation` preset with cooldown 0 flaps forever; with 300 s it converges slowly |
| Instance warm-up | AWS `DefaultInstanceWarmup: 300` | compounding orders (warming instances excluded from metric, counted toward desired) | scale-in blocked while anything warms; second scale-out step waits a full warm-up | AWS TT on the step: 4 at t≈540, 6 at t≈1000, ~7 min of errors, zero overshoot |
| Alarm evaluation periods | AWS AlarmHigh 3 datapoints, AlarmLow 15 | reacting to noise; scale-in on transient dips | +3 min dead time on every scale-out; 15 min before any scale-in | — |
| Tolerance / dead band | HPA `tolerance: 0.1`, AWS AlarmLow at 90 % of target | chatter around the setpoint | steady-state sits anywhere in the band; small clusters look "far from target" | AWS docs say this explicitly |
| Longer metric window | HPA metric window, CloudWatch period | noise | adds window/2 to dead time | — |
| Lower target utilization | HPA target 50 % vs 80 % | dead-time exposure (headroom absorbs onset) | pay for idle capacity permanently | headroom is the only knob that helps *before* D elapses |
| Faster boot | smaller image, warm pool, lazy init | shrinks D itself | engineering cost; warm pools are paid capacity | every failure above scales with D |
| Max instances | HPA `maxReplicas`, ASG max | runaway cost | hard ceiling = designed outage at that load | — |
| Non-saturating signal | requests-per-target, queue depth, concurrency | wrong-magnitude steps under overload | still lags; throughput signal *drops* when upstream fails (looks like less load) | scenario `foh.2` |

## Where each real controller is weak

| Controller | Good at | Weak at |
|---|---|---|
| **k8s HPA** (defaults) | steps and ramps on CPU; no overshoot thanks to unready-pod rule; 15 s reaction | sub-minute bursts (T=15 s, scrape 15 s); anything where CPU lies (I/O-bound hangs report 0 %, GC storms report 100 %); scale-down 5 min behind |
| **AWS target tracking** | not flapping; conservative rounding; never over-orders during warm-up | speed: ≥ 4 min to first action, one step per warm-up; 15 min to scale in; blind while alarms say INSUFFICIENT_DATA |
| **AWS step scaling** | big jumps for big breaches; keeps stepping while alarm breached | you have to guess the step table; same warm-up latency; two alarms to keep from overlapping |
| **AWS simple scaling** | simple | one fixed step per cooldown: wrong step size = either flapping (too small a cooldown) or hopelessly slow |

## Load shapes vs. controllers

| Load shape | Characteristic time | Who copes |
|---|---|---|
| diurnal curve | hours | everyone; even simple scaling |
| marketing-email ramp | 10–30 min | HPA fine; AWS TT late by ~5 min but no overshoot |
| step (failover, cache flush, retry storm) | seconds | nobody; only pre-provisioned headroom and load shedding |
| periodic burst with period ≈ 2D | minutes | resonance: every controller oscillates; cooldown/stabilization turns it into a slow oscillation instead of a fast one |
| upstream failure → throughput drops | minutes | throughput-based scalers scale *in*; CPU-based scalers see idle and scale in too |

## Rules we keep re-deriving

1. Headroom is the only thing that works inside the dead time. Size for it.
2. Make D small before tuning anything else. Every knob's cost is proportional to D.
3. Never sample faster than the plant responds: T ≥ D is safe and sluggish; T ≪ D needs an anti-windup rule (HPA has one, AWS has warm-up). Don't disable them.
4. A signal that saturates or lies will be believed. Prefer queue depth / concurrency / requests-per-target; guard with health checks that actually fail on hangs.
5. Set `max`. It is the outage you designed, instead of the bill you didn't.
6. Scale-in is the dangerous direction: it removes capacity based on a metric that lags, in a system whose next load step you can't see. Stabilize it hard.

## For building sims

- To show overshoot, don't use HPA defaults — it won't. Use AWS simple scaling with cooldown 0, or HPA with `scaleUpPods` huge and readiness delay 0 (that is the "generic" policy in `scaler.ts`).
- To show slow response, use AWS TT defaults with metric delay 60 s.
- To show lying metrics, use `hang` + `hungCpu: spinning` (scales out on nothing) or `idle` (scales in on a stuck cluster).
- To show resonance, drive a periodic load with period ≈ 2 × (boot + window).
- Every scenario should print "needed" next to "peak" and "final": the gap is the story.
