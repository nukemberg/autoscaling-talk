# sim — discrete-event simulation for the talk

Hand-rolled, zero-dependency TypeScript DES. Runs in the browser inside Slidev
components and in vitest. Time units are abstract (treat as seconds).

```
Arrivals ──▶ LoadBalancer ──▶ Instance ──▶ (Upstream)
                 ▲               │
                 │            onDone ──▶ Stats / Recorder
              Cluster ◀── Autoscaler ◀── signal()
```

| file | what |
|---|---|
| `engine.ts` | `Sim`: event heap, `schedule/scheduleAt/cancel`, `run(until)`, `step()` |
| `rng.ts` | seeded mulberry32 + exp/uniform/normal/poisson |
| `metrics.ts` | `Tally` (percentiles), `TimeWeighted`, `Recorder` (uPlot-shaped series) |
| `arrivals.ts` | non-homogeneous Poisson via thinning; `constant/step/ramp/spike/sum` |
| `pool.ts` | `Pool`: generic slot resource — acquire / FIFO queue up to `queueLimit` / reject, optional poisoning (leaked slots), time-weighted `busy` |
| `instance.ts` | scaling unit: boot delay; a request holds a worker-pool slot (envelope) while walking a per-request `Step` plan, each step holding a named pool (`cpuPool`, other `instancePools`, or shared `clusterPools`) for its duration; `cpu` (instantaneous) and `cpuSeconds` (cumulative, for scraping); hang / slow faults; custom `work` |
| `lb.ts` | round-robin / least-conn; optional health-check interval (registration lag) |
| `upstream.ts` | shared dependency: capacity, queue, slowdown, timeout (query keeps running), collapse + recovery |
| `cluster.ts` | launches/terminates instances (youngest first), `instanceTime` for billing; builds `clusterPools` once and shares them into every instance |
| `stats.ts` | windowed throughput / error rate / latency percentiles |
| `scaler.ts` | generic sampled controller (reference / tests); scenarios use `controllers/` |
| `controllers/metrics.ts` | `PodMetrics`: per-instance scrape history (metrics-server / CloudWatch stand-in) over a pluggable `MetricSource` — a cumulative counter (rate over the window) or a point-sample gauge (mean over the window); defaults to the cumulative `cpuSeconds` counter |
| `controllers/hpa.ts` | Kubernetes HPA: sync 15 s, tolerance 0.1, unready pods set aside (0% up / 100% down), 300 s down-stabilization, scaleUp max(4 pods, 100%)/15 s |
| `controllers/aws.ts` | AWS target tracking (1-min datapoints, AlarmHigh 3 / AlarmLow 15 @ 90%, instance warm-up), step scaling (step tables, AWS rounding), simple scaling (cooldown 300 s) |
| `faults.ts` | kill / hang / slow / rollingRestart / upstreamOutage / upstreamSlow |
| `cost.ts` | bill = instance-time × price + integrated extra rate |

| `scenarios/types.ts` | `ScenarioDef`: declarative params (`ParamSpec`), `run()`, `charts` |
| `scenarios/shared.ts` | reusable param groups (load / unit / scaler) and their wiring; `attachController` wires every toggled metric into Hpa (max across all) or the single first-toggled one into AWS |
| `scenarios/metricRegistry.ts` | per-pod scaling metrics a scenario can toggle on (cpu/worker/queue/rps) as `MetricSource`s; `latencyMetric()` builds the cluster-wide (not per-pod) latency metric from `Stats` |
| `scenarios/cpu.ts` | first scenario: CPU target tracking under a load step |
| `scenarios/preset.ts` | `{id, params}` JSON the workbench exports and slides load |

```sh
npm test            # vitest, includes M/M/1 and M/M/2 checks against queueing theory
npm run typecheck
npm run bench       # workbench on :3032 — tune params, copy/download preset JSON
```

Slides: drop the JSON into `presets/<name>.json`, then
`<Sim preset="name" :expose="['rps', 'countInFlight']" />`.
