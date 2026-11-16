# Autoscaling: Cost Optimization Turned Reliability Nightmare

Slides, simulations and notes for a ~30 min talk by Avishai Ish-Shalom
([@nukemberg](https://x.com/nukemberg)), first given at Reversim 2026.

## What the talk is about

Autoscaling is sold as automagic: it makes capacity problems go away. In
practice it is a **feedback control loop** bolted onto your production system,
and it brings failure modes static capacity never had.

The talk argues that:

- Autoscaling is **cost optimization, not scale-out**. Design and test for max
  capacity, then scale *down* from there.
- Scaling on symptoms (latency, CPU) closes a feedback loop. Control theory
  explains why: dead time, gain, discrete sampling, stateful vs stateless
  controllers.
- Default setups **oscillate**. Metric pipeline delay, LB registration and
  health checks are all dead time.
- N instances means N× connection pools, so scale-out spreads blast radius.
  Recovery becomes a thundering herd.
- Unstable units (unbounded concurrency, no load shedding) hide load from the
  controller.
- With no max, external actors can run your bill up. Every knob that removes
  one failure mode buys another.

Most claims are backed by live, in-browser discrete-event simulations, so you
can poke at them yourself.

## Links

- **Slides:** <https://autoscaling-rant.fewbytes.com>
- **Simulation workbench:** <https://autoscaling-rant.fewbytes.com/workbench/>
- **Control-theory shower game:** <https://autoscaling-rant.fewbytes.com/shower/>

## Extra docs

| Doc | What it covers |
| --- | --- |
| [docs/outline.md](docs/outline.md) | Slide-by-slide outline, timing and sim presets |
| [docs/controller-tradeoffs.md](docs/controller-tradeoffs.md) | Autoscaler knobs and the failure mode each one trades for |
| [docs/queueing-networks.md](docs/queueing-networks.md) | Explainer for the queueing model behind the sims |
| [docs/extra-stuff.md](docs/extra-stuff.md) | Bonus material that didn't fit in the time slot |
| [presentation/sim/README.md](presentation/sim/README.md) | The discrete-event simulation engine |

Related: [The Math of Scalability](https://nukemberg.github.io/the-math-of-scalability/).

## Repo layout

- `presentation/` — Slidev deck (`slides.md`), sim engine (`sim/`), presets,
  workbench (`bench/`) and shower game (`control-theory-game/`)
- `docs/` — notes and explainers

## Running locally

Uses Node 25.2.1 (pinned via mise).

```bash
cd presentation
npm install
npm run dev          # slides at http://localhost:3030
npm test             # sim tests (vitest)
npm run build:site   # slides + workbench + game into dist/
npm run deploy       # Cloudflare Workers (wrangler)
```
