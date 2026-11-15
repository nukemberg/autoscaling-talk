<script setup lang="ts">
/**
 * Universal Scalability Law: X(N) = N / (1 + α(N−1) + βN(N−1)).
 * α = contention (Amdahl: the serial part), β = coherence/crosstalk (makes it go *down*).
 * Static SVG, so it stays crisp at any projector size. Colors come from the deck's chart vars.
 */
const alpha = 0.03, beta = 0.0004
const W = 1000, H = 400, L = 70, R = 20, T = 20, B = 60
const nMax = 100
const usl = (n: number) => n / (1 + alpha * (n - 1) + beta * n * (n - 1))
const yMax = 19 // the ideal line runs off the top: that is the point
const x = (n: number) => L + (n / nMax) * (W - L - R)
const y = (v: number) => H - B - (v / yMax) * (H - T - B)
const curve = Array.from({ length: nMax * 2 + 1 }, (_, i) => i / 2)
  .map((n, i) => `${i ? 'L' : 'M'}${x(n).toFixed(1)},${y(usl(n)).toFixed(1)}`).join(' ')
const ideal = `M${x(0)},${y(0)} L${x(yMax)},${y(yMax)}`
const target = { x: x(38), y: y(usl(38)) } // diminishing-returns region, short of the peak
</script>

<template>
  <svg class="usl" :viewBox="`0 0 ${W} ${H}`" role="img" aria-label="Universal scalability law: throughput vs instances — linear, then diminishing returns, then decline">
    <!-- axes -->
    <line :x1="L" :y1="H - B" :x2="W - R" :y2="H - B" class="axis" />
    <line :x1="L" :y1="T" :x2="L" :y2="H - B" class="axis" />
    <text :x="(L + W - R) / 2" :y="H - 12" class="lbl" text-anchor="middle">instances</text>
    <text :x="18" :y="(T + H - B) / 2" class="lbl" text-anchor="middle" :transform="`rotate(-90 18 ${(T + H - B) / 2})`">throughput</text>
    <!-- ideal linear scaling -->
    <path :d="ideal" class="ideal" />
    <text :x="x(yMax) + 14" :y="y(yMax) + 22" class="note">linear (what we imagine)</text>
    <!-- the real curve -->
    <path :d="curve" class="curve" />
    <!-- annotation: where max lives -->
    <g class="callout">
      <path :d="`M${target.x},${target.y + 118} L${target.x},${target.y + 26}`" class="arrow" />
      <polygon :points="`${target.x},${target.y + 8} ${target.x - 14},${target.y + 32} ${target.x + 14},${target.y + 32}`" class="arrowhead" />
      <text :x="target.x" :y="target.y + 156" class="warn" text-anchor="middle">You're designing for this</text>
    </g>
  </svg>
</template>

<style scoped>
.usl { width: 100%; height: auto; display: block; }
.axis { stroke: var(--chart-muted, #888); stroke-width: 2; }
.lbl { fill: var(--chart-muted, #888); font-size: 22px; font-family: inherit; }
.note { fill: var(--chart-muted, #888); font-size: 20px; font-style: italic; }
.ideal { fill: none; stroke: var(--chart-muted, #888); stroke-width: 3; stroke-dasharray: 8 8; }
.curve { fill: none; stroke: var(--chart-text, #1a1a1a); stroke-width: 6; stroke-linecap: round; }
.arrow { fill: none; stroke: var(--c-symptom, #e11d48); stroke-width: 5; stroke-linecap: round; }
.arrowhead { fill: var(--c-symptom, #e11d48); }
.warn { fill: var(--c-symptom, #e11d48); font-size: 32px; font-weight: 800; }
</style>
