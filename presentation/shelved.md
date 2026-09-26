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
