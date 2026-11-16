# Autoscaling: Cost Optimization Turned Reliability Nightmare

Slides, simulations and notes for a ~30 min talk by Avishai Ish-Shalom
([@nukemberg](https://x.com/nukemberg)), first given at Reversim 2026.

**Slides:** <https://autoscaling-rant.fewbytes.com> ·
**Workbench:** <https://autoscaling-rant.fewbytes.com/workbench/> ·
**Shower game:** <https://autoscaling-rant.fewbytes.com/shower/>

## The pitch

Autoscaling is sold as automagic: turn it on and capacity problems go away.
What you actually get is a feedback controller wired into production. It has
its own failure modes, and static capacity never had any of them. The talk
makes four arguments.

### 1. It's cost optimization, not scale-out

Shared resources (databases, locks, caches) put a ceiling on how far a system
scales, and past a point throughput goes *down* (Universal Scalability Law).
That ceiling is a property of your architecture, so you find it with load
tests. The autoscaler can't find it for you. Once max is known, the
autoscaler's only job is to avoid running at max when you don't need to. You
scale **down** from a tested max, not **up** from a hopeful min. Treat it as
capacity engineering and production will be where you learn you can't scale.

### 2. It's a control loop, and control loops have physics

Every autoscaler is a discrete, sampled feedback controller, and three ideas
explain most of its behavior:

- **Dead time.** Metric lag, sync period, boot, health checks and LB
  registration add up, and no setting removes them. If load moves faster than
  the dead time, capacity always arrives for a world that has already moved on.
- **Gain.** Large corrections overshoot and oscillate. Small ones are stable
  but always behind.
- **Visibility.** The controller only sees a sampled, windowed slice of the
  past. You can't react faster than you look.

No controller handles every case. Each knob fixes one failure mode and pays
for it with another, and the defaults usually oscillate.

### 3. It's steering on the wrong variable

What you want to scale on is demand, but per-instance demand is hard to
measure. So everyone scales on symptoms like latency and CPU, which means
feedback on a confounded signal. An upstream bottleneck raises latency, the
autoscaler adds compute that doesn't help, and the loop runs away. CPU is
closer to the cause but still nonlinear (queueing hockey stick), polluted by
GC, locks and background work, and it saturates under overload.

### 4. Scaling changes the system it's scaling

More instances is not just more of the same system. N instances means N
connection pools pointed at the same database. New instances start cold, and
recovery turns into a thundering herd, so scale-out widens the blast radius.
Whether a unit can **say no** decides how it fails: a unit that can reject
work fails fast with errors, and one that can't fails slowly as latency.
Outside actors (retry storms, scrapers, attackers) can drive the signal and
your bill. Autoscaling also takes away the pressure to fix the inefficiency
it's paying for.

### Bottom line

Default to static capacity and make autoscaling earn its complexity. When you
do use it: load-test max, build units that shed load, scale on a signal that
tracks demand, tune slowly and on purpose, and always set `max`. The fix is
often *less* autoscaling: headroom, load shedding and backpressure.

## Simulations, not slideware

Nearly every claim is backed by a live, in-browser discrete-event simulation
(latency runaway, CPU oscillation, metric-pipeline delay, overshoot cost,
threaded vs event-loop units under the same pulse). The slides expose the key
knobs, so you can change them and break things yourself. The
[workbench](https://autoscaling-rant.fewbytes.com/workbench/) exposes all of
them.

## Further reading

| Doc | What it covers |
| --- | --- |
| [docs/outline.md](docs/outline.md) | Slide-by-slide outline, timing and sim presets |
| [docs/controller-tradeoffs.md](docs/controller-tradeoffs.md) | Every autoscaler knob and the failure mode it trades for |
| [docs/queueing-networks.md](docs/queueing-networks.md) | The queueing model behind the sims |
| [docs/extra-stuff.md](docs/extra-stuff.md) | Material that didn't fit the time slot |
| [presentation/sim/README.md](presentation/sim/README.md) | The discrete-event simulation engine |

Related: [The Math of Scalability](https://nukemberg.github.io/the-math-of-scalability/) ·
[What's the Cost of a Millisecond? (SREcon21)](https://www.usenix.org/system/files/srecon21_slides_ish-shalom.pdf)

## Repo layout

- `presentation/`: Slidev deck (`slides.md`), sim engine (`sim/`), presets,
  workbench (`bench/`) and shower game (`control-theory-game/`)
- `docs/`: notes and explainers

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
