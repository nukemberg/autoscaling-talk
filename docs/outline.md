# Outline — Autoscaling: Cost Optimization Turned Reliability Nightmare

Working doc for the talk structure. Slide source: `presentation/slides.md`.
Budget: 30 min total (27 min content + 3 min buffer, frontmatter `duration`).
Status tracks `bd` content tickets (`autoscaling-talk-kur.*`) and sim tickets
(`autoscaling-talk-foh.*`).

1. **Autoscaling** (title) — done — cold open
2. **We Love Autoscaling** — done — the pitch played straight (automagic, makes issues go away, simple, widely-tooled); click reveals Putin-laughing meme
3. **You're Not Scaling Up, You're Scaling Down** — 1.5m — done — `kur` (pre-epic)
   Design/test for max regardless; USL; scaling down from max not up from min → autoscaling is cost optimization, not scaleout
4. **What Could Possibly Go Wrong** — 1.5m — done — `kur.1`
   Autoscaling ≠ static capacity, it's dynamic; feedback loop → new failure modes; teases 3 war stories
5. **Scaling by Metrics, FTW! 🤦** — 5m — done — `kur.2`
   Cards: demand (cause) vs symptoms (effect); latency is an effect not a shortage; scaling on symptoms = closed feedback loop → pivot to control theory
6. **Control Theory Crash Course** — 6m — done — `kur.3`
   4 insights: characteristic/dead time, gain, discrete sampling, stateful vs stateless controllers. No controller is perfect, always a tradeoff
7. **Oscillation, by Default** — (in #6) — done — live sim: AWS simple scaling, cooldown 0 → sustained flapping
8. **Coupling and Blast Radius** — 4m — done — `kur.5`
   N instances = N× connection pools; LB registration + health checks = dead time on the add side; recovery is a herd; fast-onset load beats any scaler with dead time > onset time
9. **Unstable Scaling Units** — 3m — done — `kur.6`
   Well-behaved vs bad unit; "your controller doesn't know the server load if it hides it"; live sim: loss vs node.js unit model, same load, 2% → 54% errors
10. **Loss vs. Node.js, Same Load** — (in #9) — done — live sim companion to #9
11. **The Cost Problem** — 3m — done — `kur.7`
    External actors, runaway upstream costs, no max; Agent-HPA "License to Spend" meme
12. **Comfortable Patch** — 1m — done
    The engineering feedback loop (not the control one): autoscaling absorbs perf problems painlessly, removing pressure to fix them; not reducing per-request cost, just paying for more capacity forever. Drake meme as the visual centerpiece (image-right layout)
13. **Responsible Autoscaling** — 6m — done — `kur.8`
    Design for max first, well-behaved units, right signal, tune the loop, protect upstream — less autoscaling is often the fix
14. **Summary** — 2m — done — `kur.8` — simpler is often better
15. **Thank You** — done — —
16. **Bonus: every knob is a trade** — done — dense knob/tradeoff table for photos

## Not yet scheduled into slides.md

- **kur.4** — HPA/ASG defaults table mapped to control terms (P2)
- **kur.9** — war stories: anonymize + verify the 3 real incidents referenced in speaker notes (P2)
- **kur.10** — "HPA is a P controller with gain 1" walkthrough (P2)

## Sim scenarios (foh epic) — status

- **foh.2** — scale-in on upstream failure, fail to recover (feeds Coupling) — not built
- **foh.3** — thundering herd from runaway scaling (feeds Coupling) — not built
- **foh.4** — unstable scaling unit sim — **superseded**: built directly as the `unitModel` sim feature (loss/bounded-queue/node.js) instead of a one-off scenario; see slide 10
- **foh.7** — the fix: headroom + load shedding + backpressure vs autoscaler (feeds Responsible Autoscaling) — not built
- **foh.8** — control theory step-response demo — **done**, this is the `cpu-step`/`cpu-oscillation` sim already on slides 6–7
- **foh.5**, **foh.6** — external actor / runaway cost sims (feed The Cost Problem) — not built, P2

## Open threads (not slide content, tracked here so they don't get lost)

- **Unit models**: `loss` / `bounded-queue` / `node.js` implemented in `sim/scenarios/shared.ts`. See `docs/extra-stuff.md` for the threaded-server-as-internal-LB angle (not yet decided whether it's slide content or bonus).
- **Small vs. large servers**: autoscaling favors small units (finer-grained, faster boot-to-useful ratio), raw efficiency favors large ones (less per-unit overhead, better bin-packing). Tension noted, not yet placed — see `docs/extra-stuff.md`.
- **Load shedding**: belongs conceptually on the Unstable Scaling Units slide but there's no time budget for the full discussion there — longer treatment lives in `docs/extra-stuff.md`.
- **Perf**: `autoscaling-talk-q30` — sim recompute time for heavy presets; slide sims now run in a worker (non-blocking) but raw compute time is unchanged.
- **Meme asset sizes**: `presentation/public/memes/*` are 2-4MB each (uncompressed JPEG/GIF) — fine locally, worth compressing before deploy (ties into `usx.5`).

## Design system

`presentation/styles/index.css` — `.content` (body), `.takeaway` (→ conclusion),
`.cards`/`.card` (comparison layout), `.accent-*` (inline color), `.meme`
(corner-placed illustrative image via `abs-br m-4`), `.tradeoffs` (bonus table).
Use these instead of ad-hoc styling so slides stay visually consistent.
