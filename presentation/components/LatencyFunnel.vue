<script setup lang="ts">
/**
 * Latency Trap war-story diagram. A fleet of instances (left) all funnels into one
 * shared, fixed-size resource (right). Driven by Slidev's click counter:
 *   0  few instances, latency creeping up
 *   1  autoscaler reacts: fleet starts growing
 *   2  fleet keeps growing, latency still high
 *   3  fleet maxed out, latency pegged — the symptom was never the problem
 * Deliberately number-free: the shape (many → few) is the point, not the counts.
 */
import { computed } from 'vue'

const props = defineProps<{ step: number }>()

const COLS = 12
const ROWS = 5
const CELL = 30
const GAP = 7

// How many cells are lit at each step (index = step).
const LIT = [6, 15, 35, 60]
const lit = computed(() => LIT[Math.min(props.step, LIT.length - 1)])

// Fill column-major so the fleet visibly grows left → right.
const cells = Array.from({ length: COLS * ROWS }, (_, i) => {
  const col = Math.floor(i / ROWS)
  const row = i % ROWS
  return { i, x: col * (CELL + GAP), y: row * (CELL + GAP) }
})

const gridW = COLS * (CELL + GAP) - GAP
const gridH = ROWS * (CELL + GAP) - GAP

const FUNNEL_X = gridW + 24
const FUNNEL_W = 190
const midY = gridH / 2
const dbX = FUNNEL_X + FUNNEL_W + 6
const dbW = 150
const dbH = 108

// DB slots never change: that's the whole story.
const slots = Array.from({ length: 8 }, (_, i) => ({ x: dbX + 22 + (i % 4) * 30, y: midY - 30 + Math.floor(i / 4) * 36 }))

// Latency gauge: 0..1 fill per step.
const LATENCY = [0.22, 0.5, 0.75, 0.98]
const latency = computed(() => LATENCY[Math.min(props.step, LATENCY.length - 1)])
const GAUGE_W = dbW + 40
const gaugeX = dbX - 20
const gaugeY = gridH + 46

const captions = [
  'Latency creeps up.',
  'Autoscaler’s answer: add instances.',
  'Latency still high. Add more.',
  'The metric measured <strong>the symptom</strong>, so the autoscaler could only treat <strong>the symptom</strong>.',
]
const caption = computed(() => captions[Math.min(props.step, captions.length - 1)])
const final = computed(() => props.step >= 3)
</script>

<template>
  <div class="latency-funnel">
    <svg :viewBox="`-4 -4 ${dbX + dbW + 48} ${gridH + 84}`" role="img" aria-label="Many instances funnel into one fixed-size shared resource">
      <!-- instances -->
      <rect
        v-for="c in cells"
        :key="c.i"
        class="cell"
        :class="{ on: c.i < lit }"
        :x="c.x" :y="c.y" :width="CELL" :height="CELL" rx="5"
        :style="{ transitionDelay: c.i < lit ? `${Math.max(0, c.i - 6) * 18}ms` : '0ms' }"
      />
      <!-- funnel -->
      <polygon
        class="funnel"
        :points="`${FUNNEL_X},-2 ${FUNNEL_X + FUNNEL_W},${midY - 24} ${FUNNEL_X + FUNNEL_W},${midY + 24} ${FUNNEL_X},${gridH + 2}`"
      />
      <!-- shared resource: fixed size, never grows -->
      <rect class="db" :class="{ hot: step >= 1 }" :x="dbX" :y="midY - dbH / 2" :width="dbW" :height="dbH" rx="14" />
      <rect v-for="(s, i) in slots" :key="i" class="slot" :class="{ hot: step >= 1 }" :x="s.x" :y="s.y" width="24" height="24" rx="4" />
      <text class="lbl" :x="dbX + dbW / 2" :y="midY - dbH / 2 - 10" text-anchor="middle">shared pool · fixed size</text>
      <text class="lbl inst" x="0" :y="gridH + 24">instances</text>

      <!-- latency gauge -->
      <text class="lbl lat" :x="gaugeX" :y="gaugeY - 8">latency</text>
      <rect class="gauge-bg" :x="gaugeX" :y="gaugeY" :width="GAUGE_W" height="16" rx="8" />
      <rect class="gauge" :x="gaugeX" :y="gaugeY" :width="GAUGE_W * latency" height="16" rx="8" />
    </svg>
    <div class="caption" :class="{ final }" :key="step" v-html="caption" />
  </div>
</template>

<style scoped>
/* Fixed width in slide-canvas px: the statement layout centers content in a shrink-to-fit
   wrapper, so width:100% collapsed to the current (short) caption's width. */
.latency-funnel { width: 810px; max-width: 100%; padding-bottom: 1.5rem; }
svg { width: 100%; height: auto; display: block; }

.cell { fill: var(--c-takeaway, #d97706); opacity: 0.1; transition: opacity 0.35s ease; }
.cell.on { opacity: 0.9; }

.funnel { fill: color-mix(in srgb, var(--c-symptom, #e11d48) 14%, transparent); stroke: var(--c-symptom, #e11d48); stroke-width: 3; }

.db { fill: color-mix(in srgb, var(--c-symptom, #e11d48) 8%, transparent); stroke: var(--c-symptom, #e11d48); stroke-width: 4; opacity: 0.6; transition: opacity 0.4s; }
.db.hot { opacity: 1; }
.slot { fill: var(--c-symptom, #e11d48); opacity: 0.35; transition: opacity 0.4s; }
.slot.hot { opacity: 1; }

.lbl { font-size: 17px; font-weight: 700; fill: currentColor; opacity: 0.7; }
.lbl.inst { fill: var(--c-takeaway, #d97706); opacity: 1; }
.lbl.lat { fill: var(--c-symptom, #e11d48); opacity: 1; }

.gauge-bg { fill: color-mix(in srgb, currentColor 12%, transparent); }
.gauge { fill: var(--c-symptom, #e11d48); transition: width 0.7s ease; }

.caption { margin-top: 0.75rem; font-size: 1.8rem; font-weight: 700; line-height: 1.2; min-height: 5rem; animation: cap-in 0.3s ease; }
.caption.final { font-size: 1.9rem; font-weight: 800; }
.caption :deep(strong) { color: var(--c-symptom, #e11d48); }
@keyframes cap-in { from { opacity: 0; transform: translateY(6px); } to { opacity: 1; transform: none; } }
</style>
