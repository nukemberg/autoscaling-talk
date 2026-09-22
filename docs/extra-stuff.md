# Extra stuff — bonus round material

Things that don't fit in 27 minutes. Each entry: the pattern, why it bites,
what the control-theory view says, and whether we could sim it.

## Patterns people actually run

### Spot instances under an autoscaler
- Capacity can vanish on 2 minutes' notice, in bulk, correlated across an AZ / instance type.
- Control view: the plant now has a random negative step input that the controller did not order. Dead time to replace = boot + the time until the spot pool has capacity again (unbounded).
- Interactions: replacement instances are also spot → same pool → same interruption. ASG "capacity rebalancing" launches replacements *before* termination — i.e. it deliberately over-provisions; good, but it looks like a scale-out to the metric.
- Sim: `kill` fault with a fraction, replacement delay long and variable; add `spotPool` capacity cap so replacements fail for N minutes.

### Double scaling: HPA on top of a cluster autoscaler / Karpenter
- Two nested loops with different dead times: HPA (15 s sync, pods boot in seconds if there is a node) inside node provisioning (1–5 min). Pods go Pending, HPA sees Pending pods as unready → sets them aside → recomputes → holds. Fine. Then nodes arrive, 20 pods schedule at once, CPU per pod drops, HPA scales in, node autoscaler consolidates the now-empty node, next spike repeats. Two loops with periods ~10× apart resonate on the slow one.
- Karpenter consolidation is a *third* controller working against the other two: it bins pods tighter to kill nodes; disruption budgets are the only damping.
- Control view: cascaded control with the inner loop faster than the outer is the textbook-correct arrangement, but only if the inner loop saturates gracefully (Pending pods = saturation). Consolidation adds a negative feedback on cost that fights the positive-headroom intent.
- Sim: two-level cluster model: nodes (slots for pods, boot 120–300 s) + pods (boot 10 s). Worth building if time — it is the most common real setup.

### Scaling on latency
- Latency is caused by anything: upstream, GC, a bad deploy, a lock. Controller scales out on all of them; only capacity-caused latency responds. Runaway to max on a DB slowdown is the canonical story (our `foh.3`).
- AWS explicitly lists ELB latency as a metric that does *not* work for target tracking. People do it anyway with custom metrics.

### Scaling on queue depth
- The right signal for workers, but: queue depth per worker (not raw depth), and a deep queue after an outage means a herd on the downstream when workers scale out. KEDA scales to zero — then the first message pays the full boot.
- Control view: integral of the error, not the error. Integral signals are lagging by construction; pair with a rate term (enqueue rate) or you scale out after the backlog is already gone.

### Scale-to-zero
- Boot time becomes user-facing latency. Every cold start is a dead-time exposure with zero headroom. Fine for batch, dangerous for anything with a human on the other end.

### Predictive / scheduled scaling
- Feed-forward. The only thing that beats dead time — if the forecast is right. Wrong forecast = paid idle or a step the feedback loop must catch anyway. Use for the diurnal shape, keep feedback for the residual.

### Autoscaling stateful things
- Databases, Kafka partitions, shards: "boot time" includes data movement; dead time is hours and rebalancing itself costs capacity. Scale-in is a migration. Feedback control over hours with load that changes over minutes: don't.

### Multiple autoscalers on the same target
- Two HPAs, or HPA + a custom operator, or ASG target tracking + step scaling on different metrics. AWS: scale-out wins if any policy wants it, scale-in only if all agree — sensible. k8s: undefined, they fight.

### Retry storms and the herd
- Clients retry on 503; offered load doubles exactly when capacity is shortest. Scaler sees 2× and orders 2×. When capacity lands, retries stop, load halves, scaler scales in. Amplifier on both edges. (`xjm.11` sim.)

### Warm pools, over-provisioning pods, pause pods
- All the same trick: buy dead-time cover with idle capacity. The honest form of "just turn on autoscaling".

### Cost-side surprises
- Per-instance costs that don't scale down: NAT gateway, LB LCUs, log ingestion, per-connection DB pricing, RDS Proxy. Scaling out 50 instances for 20 minutes can cost more in egress and logs than in compute.
- Scaling is an attack surface: economic DoS. `max` is your rate limit on your own wallet.

### Threaded servers are their own nested autoscaler
- A threaded/worker-pool server (Java thread pools, Gunicorn/Puma workers, connection-pool-backed services) is a scaling system inside your scaling system: it has its own admission control (accept vs. queue vs. reject a new connection/request), its own "capacity" (pool size, often dynamically resized between min/max), and sometimes its own feedback loop (dynamic pool sizing based on queue depth or load).
- That inner loop has its own dead time (thread/worker spin-up), its own gain, its own saturation behavior — and it's invisible to the outer autoscaler, which only sees the outer unit's aggregate metric. Two nested control loops, same resonance risk as HPA-on-cluster-autoscaler (see "Double scaling" above), except this one is usually undocumented and untuned by whoever owns the outer autoscaler.
- Practical implication: "instance concurrency" in our sim (`unitParams.concurrency`) is really standing in for whatever this inner pool's effective ceiling is — which may itself be a moving target, not a fixed config value.

### Small servers vs. big servers — autoscaling and efficiency want different things
- Autoscaling likes small units: finer granularity (add/remove capacity in small increments, less overshoot per step), faster boot-to-useful ratio relative to unit size, lower blast radius per unit lost.
- Raw efficiency likes big units: less per-unit fixed overhead (OS, sidecars, connection pool minimums, base memory), better bin-packing / statistical multiplexing (a bigger pool of shared slots absorbs bursty load with less reserved headroom — same logic as trunking in queueing theory).
- No universal answer; it's a real tension between the scaling story and the cost-efficiency story, worth a beat if there's room but doesn't have a clean one-liner resolution. (Not currently in slides.md — see `docs/outline.md`.)

### Load shedding, longer version
- The slide (Unstable Scaling Units) only has room for "well-behaved unit sheds fast, bad unit doesn't." Fuller picture if there's time in Q&A or a bonus slide:
  - Shedding needs to happen at admission, before work is accepted — rejecting after doing most of the work (e.g. after an upstream call) wastes the capacity you were trying to protect.
  - Cheap signals for "should I shed": queue depth / in-flight count vs. a threshold, not latency (latency is a lagging, integral-like signal — see `kur.2`'s queue-depth note).
  - Shedding needs to be visible to the thing consuming your metrics — an instance that silently drops requests looks "fine" (low CPU, low latency for the requests it *did* serve) to an autoscaler watching aggregate load, which is its own version of the node.js "doesn't shed, lies about load" failure mode, just in the opposite direction (this one lies by omission).
  - Priority shedding (shed low-priority traffic first) is strictly better than random shedding but needs the caller to have told you the priority — most systems don't have this wired end-to-end.

## Notes from our sims (so far)

Setup unless noted: 16 slots/instance, 100 ms service → 160 rps/instance, target 50 %, boot 120 s, LB health check 10 s × 3 fails / 2 passes. Base 100 rps → step to 400 at t=300 s; needs 5 instances.

| Controller | Result | Note |
|---|---|---|
| Generic "HPA formula" ticking every 30 s, no unready rule (our first cut) | peak 59, three decaying cycles, settles at 5 after ~10 min, 2.4 % errors | This is what people *think* HPA does. It isn't. |
| Same, counting in-flight instances | peak 7, converges in 2 boot cycles, 2.4 % errors | Overshoot gone; errors identical — dead time is physics |
| **k8s HPA, defaults** | 2 → 4 → 6, no overshoot, ~2.3 % errors | The unready-pod rule *is* the anti-windup. Scale-up limit max(4, 100 %) never bound here |
| **AWS target tracking, defaults + 60 s metric delay** | 4 at t≈540, 6 at t≈1000, 5.6 % errors, zero overshoot | 3 datapoints + delay + warm-up. Slow ≠ safe: ~7 min of errors |
| AWS simple scaling ±1, thresholds 0.55/0.45, cooldown 0, 15 s period (`cpu-oscillation`) | sustained flapping | The oscillation demo. Every knob at "responsive" |
| HPA + `hang` 2 of 5 instances, CPU spinning | LB drops them after 30 s, scaler adds ~9 it doesn't need, drops them after recovery, 3.4 % errors | Metric lies are believed |
| HPA + `kill` 2 of 5, replace after 60 s | 60 s of ~40 % errors, back to 5 | ASG replacement is fine; the errors are the health-check delay |

Things the sims taught us that we didn't expect:
- A cluster with only booting instances reports utilization 0 → a naive scaler scales it *in*. Instances die before finishing boot. This fell out of the first test run, not from a war story.
- Youngest-first scale-in (the AWS/k8s default) means the instances killed during the down-swing are exactly the ones still booting — so the storm costs money but never served a request.
- Warm-up (AWS) and unready set-aside (k8s) are the same idea with opposite defaults: AWS blocks scale-in during it, k8s does not.
- With Poisson arrivals at 50 % target, 16 slots/instance, M/M/16/16 rejects ~0.1 % of requests at steady state. "Errors % 0.0" is never quite true.
- The health-check interval is dead time too: instances are ready 20 s before the LB believes it (10 s × 2 passes). Our warm-up had to account for it or the "stable" period showed 7 % errors.
- uPlot mutates the option objects you hand it. Two hours.

## Sims we could still build (cheap → expensive)
1. Periodic load at period ≈ 2 × (boot + window) → resonance with every controller.
2. Retry storm (`xjm.11`).
3. Upstream failure → throughput signal drops → scale-in → recovery herd (`foh.2`).
4. Latency-driven runaway (`foh.3`).
5. Spot interruption with pool exhaustion.
6. Two-level HPA + node autoscaler + consolidation.

## Related talks

Deeper treatments of ideas this talk only has time to gesture at:

- [Queue Theory for Node Developers](https://blog.nukemberg.com/presentation/queue-theory-for-node-developers/) — the queueing-theory background behind the M/M/c/c model and the "load metrics vs. system-response metrics" split
- [What's the Cost of a Millisecond](https://blog.nukemberg.com/presentation/whats-the-cost-of-a-millisecond/) — latency budgets and why a millisecond isn't free
- [The Math of Scalability](https://blog.nukemberg.com/presentation/the-math-of-scalability/) — the Universal Scalability Law behind "design for max, shared resources don't scale linearly"
- [Beyond Big O](https://blog.nukemberg.com/presentation/beyond-big-o/) — why asymptotic complexity alone doesn't predict real system behavior
- [We Need to Talk About Limits](https://blog.nukemberg.com/presentation/we-need-to-talk-about-limits/) — on `max`, ceilings, and why every system needs one
