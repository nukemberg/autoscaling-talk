<script setup lang="ts">
/**
 * M/M/1 queue: mean response time R = S / (1 − ρ), S = service time.
 * Plotted as a multiple of S against utilization ρ. Static SVG (crisp at any
 * projector size); colors come from the deck's chart vars.
 */
const W = 1000, H = 440, L = 90, R = 30, T = 50, B = 70
const rhoMax = 0.97
const yMax = 20
const r = (rho: number) => 1 / (1 - rho)
const x = (rho: number) => L + (rho / 1) * (W - L - R)
const y = (v: number) => H - B - (Math.min(v, yMax) / yMax) * (H - T - B)
const pts = Array.from({ length: 200 }, (_, i) => (i / 199) * rhoMax)
const curve = pts.map((p, i) => `${i ? 'L' : 'M'}${x(p).toFixed(1)},${y(r(p)).toFixed(1)}`).join(' ')
const marks = [0.5, 0.8, 0.95].map(p => ({ p, v: r(p), x: x(p), y: y(r(p)) }))
const ticks = [0, 0.25, 0.5, 0.75, 1]
const yticks = [1, 5, 10, 15, 20]
</script>

<template>
  <svg class="mm1" :viewBox="`0 0 ${W} ${H}`" role="img" aria-label="M/M/1 queue: response time vs utilization — flat, then explodes near 100%">
    <line :x1="L" :y1="H - B" :x2="W - R" :y2="H - B" class="axis" />
    <line :x1="L" :y1="T" :x2="L" :y2="H - B" class="axis" />
    <g v-for="t in ticks" :key="t">
      <text :x="x(t)" :y="H - B + 32" class="tick" text-anchor="middle">{{ Math.round(t * 100) }}%</text>
    </g>
    <g v-for="t in yticks" :key="t">
      <line :x1="L" :y1="y(t)" :x2="W - R" :y2="y(t)" class="grid" />
      <text :x="L - 10" :y="y(t) + 8" class="tick" text-anchor="end">{{ t }}×</text>
    </g>
    <text :x="(L + W - R) / 2" :y="H - 12" class="lbl" text-anchor="middle">CPU utilization</text>
    <text :x="26" :y="(T + H - B) / 2" class="lbl" text-anchor="middle" :transform="`rotate(-90 26 ${(T + H - B) / 2})`">latency (× service time)</text>
    <path :d="curve" class="curve" />
    <g v-for="m in marks" :key="m.p">
      <circle :cx="m.x" :cy="m.y" r="9" class="dot" />
      <text :x="m.x - 16" :y="m.y - 4" class="mark" text-anchor="end">{{ Math.round(m.p * 100) }}% → {{ m.v.toFixed(0) }}×</text>
    </g>
  </svg>
</template>

<style scoped>
.mm1 { width: 100%; height: auto; display: block; }
.axis { stroke: var(--chart-muted, #888); stroke-width: 2; }
.grid { stroke: var(--chart-muted, #888); stroke-width: 1; opacity: 0.25; }
.lbl { fill: var(--chart-muted, #888); font-size: 24px; font-family: inherit; }
.tick { fill: var(--chart-muted, #888); font-size: 22px; font-family: inherit; }
.curve { fill: none; stroke: var(--chart-text, #1a1a1a); stroke-width: 6; stroke-linecap: round; }
.dot { fill: var(--c-symptom, #e11d48); }
.mark { fill: var(--c-symptom, #e11d48); font-size: 28px; font-weight: 800; }
</style>
