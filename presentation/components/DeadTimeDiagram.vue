<script setup lang="ts">
/**
 * Dead-time diagram. Sources (sensing → decision → actuation) and consequences (shortage,
 * chasing) on one load-vs-capacity chart. Driven by Slidev's click counter:
 *   0  load steps up
 *   1  source 1: sensing — metrics have to catch up
 *   2  source 2: decision — the controller has to notice
 *   3  source 3: actuation — capacity has to boot and register (bar = the dead time)
 *   4  consequence: capacity finally arrives; the gap is a shortage
 *   5  consequence: load that moves faster than the delay — capacity arrives after it's gone
 * The delay bar is geometrically the gap between the load edge and the capacity edge, so the
 * diagram's shape *is* the argument. Number-free on purpose.
 */
import { computed } from 'vue'

const props = defineProps<{ step: number }>()
const s = computed(() => Math.min(props.step, 5))

// Chart geometry (viewBox units).
const X0 = 40
const X1 = 1060
const T0 = 120 // load edge
const D = 600 // dead time
const W = 300 // pulse width (< D, so capacity misses it)
const HI = 60
const LO = 240

const loadPath = computed(() =>
  s.value >= 5
    ? `M${X0},${LO} H${T0} V${HI} H${T0 + W} V${LO} H${X1}`
    : `M${X0},${LO} H${T0} V${HI} H${X1}`,
)
const capPath = computed(() =>
  s.value >= 5
    ? `M${X0},${LO} H${T0 + D} V${HI} H${T0 + D + W} V${LO} H${X1}`
    : `M${X0},${LO} H${T0 + D} V${HI} H${X1}`,
)

// Delay bar: three equal segments spanning the gap.
const BAR_Y = 268
const BAR_H = 46
const SEG = D / 3
const segs = [
  { label: 'See it', sub: 'metrics lag', n: 1 },
  { label: 'Decide', sub: 'sync · cooldown', n: 2 },
  { label: 'Do it', sub: 'boot · health · LB', n: 3 },
]

const captions = [
  'Load changes.',
  'First, the metrics have to catch up.',
  'Then the controller has to notice.',
  'Then capacity has to boot and register.',
  'Until it arrives, you’re <strong>short</strong>.',
  'Load that moves faster than this? You’re <strong>always chasing</strong>.',
]
const caption = computed(() => captions[s.value])
</script>

<template>
  <div class="dead-time">
    <svg viewBox="0 0 1100 420" role="img" aria-label="Load rises, capacity follows only after a delay made of sensing, decision and actuation lag">
      <!-- consequences: shaded areas -->
      <rect v-if="s === 4" class="area short" :x="T0" :y="HI" :width="D" :height="LO - HI" />
      <rect v-if="s >= 5" class="area short" :x="T0" :y="HI" :width="W" :height="LO - HI" />
      <rect v-if="s >= 5" class="area waste" :x="T0 + D" :y="HI" :width="W" :height="LO - HI" />
      <text v-if="s === 4" class="area-lbl short" :x="T0 + D / 2" :y="(HI + LO) / 2 + 8" text-anchor="middle">short</text>
      <text v-if="s >= 5" class="area-lbl short" :x="T0 + W / 2" :y="(HI + LO) / 2 + 8" text-anchor="middle">short</text>
      <text v-if="s >= 5" class="area-lbl waste" :x="T0 + D + W / 2" :y="(HI + LO) / 2 + 8" text-anchor="middle">wasted</text>

      <!-- baseline -->
      <line class="axis" :x1="X0" :x2="X1" :y1="LO" :y2="LO" />

      <!-- lines -->
      <path class="line load" :d="loadPath" />
      <path v-if="s >= 4" class="line cap" :d="capPath" />
      <text class="lbl load" :x="X0" :y="HI - 14">load</text>
      <text v-if="s >= 4" class="lbl cap" :x="X1" :y="HI - 14" text-anchor="end">capacity</text>

      <!-- delay bar: three sources, aligned to the gap -->
      <g v-for="(g, i) in segs" :key="g.n" class="seg" :class="{ on: s >= g.n }">
        <rect :x="T0 + i * SEG + 2" :y="BAR_Y" :width="SEG - 4" :height="BAR_H" rx="8" />
        <text class="seg-main" :x="T0 + i * SEG + SEG / 2" :y="BAR_Y + BAR_H / 2 + 8" text-anchor="middle">{{ g.label }}</text>
        <text class="seg-sub" :x="T0 + i * SEG + SEG / 2" :y="BAR_Y + BAR_H + 28" text-anchor="middle">{{ g.sub }}</text>
      </g>

      <!-- total: dead time -->
      <g class="brace" :class="{ on: s >= 3 }">
        <path :d="`M${T0 + 2},${BAR_Y + BAR_H + 52} V${BAR_Y + BAR_H + 62} H${T0 + D - 2} V${BAR_Y + BAR_H + 52}`" />
        <text :x="T0 + D / 2" :y="BAR_Y + BAR_H + 88" text-anchor="middle">dead time</text>
      </g>
    </svg>
    <div class="caption" :key="s" v-html="caption" />
  </div>
</template>

<style scoped>
/* Fixed width in slide-canvas px: the statement layout centers content in a shrink-to-fit
   wrapper, so width:100% would collapse to the current caption's width. */
.dead-time { width: 810px; max-width: 100%; padding-bottom: 1.5rem; }
svg { width: 100%; height: auto; display: block; }

.axis { stroke: color-mix(in srgb, currentColor 25%, transparent); stroke-width: 2; }
.line { fill: none; stroke-width: 7; stroke-linejoin: round; stroke-linecap: round; }
.line.load { stroke: var(--c-takeaway, #d97706); }
.line.cap { stroke: var(--c-demand, #059669); }
.lbl { font-size: 24px; font-weight: 800; }
.lbl.load { fill: var(--c-takeaway, #d97706); }
.lbl.cap { fill: var(--c-demand, #059669); }

.area.short { fill: color-mix(in srgb, var(--c-symptom, #e11d48) 16%, transparent); }
.area.waste { fill: color-mix(in srgb, var(--c-takeaway, #d97706) 16%, transparent); }
.area-lbl { font-size: 30px; font-weight: 800; }
.area-lbl.short { fill: var(--c-symptom, #e11d48); }
.area-lbl.waste { fill: var(--c-takeaway, #d97706); }

.seg rect { fill: color-mix(in srgb, var(--c-symptom, #e11d48) 8%, transparent); stroke: color-mix(in srgb, var(--c-symptom, #e11d48) 30%, transparent); stroke-width: 3; transition: all 0.4s; }
.seg.on rect { fill: color-mix(in srgb, var(--c-symptom, #e11d48) 18%, transparent); stroke: var(--c-symptom, #e11d48); }
.seg-main { font-size: 26px; font-weight: 800; fill: currentColor; opacity: 0.25; transition: opacity 0.4s; }
.seg-sub { font-size: 19px; font-weight: 600; fill: currentColor; opacity: 0; transition: opacity 0.4s; }
.seg.on .seg-main { opacity: 1; }
.seg.on .seg-sub { opacity: 0.75; }

.brace path { fill: none; stroke: var(--c-symptom, #e11d48); stroke-width: 4; stroke-linecap: round; }
.brace text { font-size: 26px; font-weight: 800; fill: var(--c-symptom, #e11d48); }
.brace { opacity: 0; transition: opacity 0.4s; }
.brace.on { opacity: 1; }

.caption { margin-top: 0.5rem; font-size: 1.8rem; font-weight: 700; line-height: 1.2; min-height: 4.5rem; animation: cap-in 0.3s ease; }
.caption :deep(strong) { color: var(--c-symptom, #e11d48); }
@keyframes cap-in { from { opacity: 0; transform: translateY(6px); } to { opacity: 1; transform: none; } }
</style>
