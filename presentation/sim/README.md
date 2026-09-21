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
| `instance.ts` | scaling unit: boot delay, concurrency, queue, `slowdown` (degradation), custom `work` |
| `lb.ts` | round-robin / least-conn; optional health-check interval (registration lag) |
| `upstream.ts` | shared dependency: capacity, queue, slowdown, timeout (query keeps running), collapse + recovery |
| `cluster.ts` | launches/terminates instances (youngest first), `instanceTime` for billing |
| `stats.ts` | windowed throughput / error rate / latency percentiles |
| `scaler.ts` | sampled controller: period, sample interval, metric delay, window, cooldowns, stabilization; `threshold` and `targetTracking` (HPA formula) policies |
| `cost.ts` | bill = instance-time × price + integrated extra rate |

| `scenarios/types.ts` | `ScenarioDef`: declarative params (`ParamSpec`), `run()`, `charts` |
| `scenarios/shared.ts` | reusable param groups (load / unit / scaler) and their wiring |
| `scenarios/cpu.ts` | first scenario: CPU target tracking under a load step |
| `scenarios/preset.ts` | `{id, params}` JSON the workbench exports and slides load |

```sh
npm test            # vitest, includes M/M/1 and M/M/2 checks against queueing theory
npm run typecheck
npm run bench       # workbench on :3032 — tune params, copy/download preset JSON
```

Slides: drop the JSON into `presets/<name>.json`, then
`<Sim preset="name" :expose="['rps', 'countInFlight']" />`.
