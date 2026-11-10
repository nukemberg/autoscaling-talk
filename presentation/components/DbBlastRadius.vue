<script setup lang="ts">
/**
 * "The Autoscaler Ate the Database" war-story diagram. Instances (left) each open their own
 * connection pool to one database (right); the tank is the DB's connection budget. Driven by
 * Slidev's click counter:
 *   0  load spike, fleet small, tank comfortably below the limit
 *   1  autoscaler scales out: fleet and connections both grow
 *   2  fleet maxed: connections blow past the limit
 *   3  database falls over; every instance loses its queries
 *   4  punchline — the autoscaler did exactly its job
 * Number-free on purpose: the shape (fleet grows, DB limit doesn't) is the point.
 */
import { computed } from 'vue'

const props = defineProps<{ step: number }>()

const COLS = 12
const ROWS = 5
const CELL = 30
const GAP = 7

const LIT = [6, 36, 60, 60, 60]
const s = computed(() => Math.min(props.step, LIT.length - 1))
const lit = computed(() => LIT[s.value])
const dead = computed(() => s.value >= 3)
const over = computed(() => s.value === 2)

const cells = Array.from({ length: COLS * ROWS }, (_, i) => {
  const col = Math.floor(i / ROWS)
  const row = i % ROWS
  return { i, x: col * (CELL + GAP), y: row * (CELL + GAP) }
})

const gridW = COLS * (CELL + GAP) - GAP
const gridH = ROWS * (CELL + GAP) - GAP

const FUNNEL_X = gridW + 24
const FUNNEL_W = 150
const midY = gridH / 2
const dbX = FUNNEL_X + FUNNEL_W + 6
const dbW = 130
const dbY = -2
const dbH = gridH + 4

// Connection tank: fill fraction per step; the limit line sits at LIMIT of the tank.
const LIMIT = 0.7
const LEVEL = [0.22, 0.58, 1, 0]
const level = computed(() => LEVEL[Math.min(s.value, LEVEL.length - 1)])
const fillH = computed(() => (dbH - 8) * level.value)

const captions = [
  'A load spike hits.',
  'The autoscaler scales out. Every instance brings its <strong>own connection pool</strong>.',
  'Together they open more connections than the database can take.',
  'The database falls over. Every instance loses its queries.',
  'It did its job perfectly. That was the problem.',
]
const caption = computed(() => captions[s.value])
const final = computed(() => s.value >= 4)
</script>

<template>
  <div class="db-blast">
    <svg :viewBox="`-4 -4 ${dbX + dbW + 12} ${gridH + 42}`" role="img" aria-label="A growing fleet of instances overwhelms a database's fixed connection limit">
      <rect
        v-for="c in cells"
        :key="c.i"
        class="cell"
        :class="{ on: c.i < lit, dead }"
        :x="c.x" :y="c.y" :width="CELL" :height="CELL" rx="5"
        :style="{ transitionDelay: c.i < lit && !dead ? `${Math.max(0, c.i - 6) * 16}ms` : '0ms' }"
      />
      <polygon
        class="funnel"
        :class="{ over: over || dead }"
        :points="`${FUNNEL_X},-2 ${FUNNEL_X + FUNNEL_W},${midY - 30} ${FUNNEL_X + FUNNEL_W},${midY + 30} ${FUNNEL_X},${gridH + 2}`"
      />

      <!-- database tank = connection budget -->
      <rect class="db" :class="{ dead, over }" :x="dbX" :y="dbY" :width="dbW" :height="dbH" rx="14" />
      <rect class="fill" :class="{ over: level > LIMIT }" :x="dbX + 4" :y="dbY + dbH - 4 - fillH" :width="dbW - 8" :height="fillH" rx="10" />
      <line class="limit" :x1="dbX - 6" :x2="dbX + dbW + 6" :y1="dbY + dbH - 4 - (dbH - 8) * LIMIT" :y2="dbY + dbH - 4 - (dbH - 8) * LIMIT" />
      <text class="lbl-limit" :class="{ on: level > LIMIT }" :x="dbX + dbW / 2" :y="dbY + dbH - 4 - (dbH - 8) * LIMIT - 8" text-anchor="middle">connection limit</text>
      <g v-if="dead" class="x">
        <line :x1="dbX + 34" :y1="midY - 30" :x2="dbX + dbW - 34" :y2="midY + 30" />
        <line :x1="dbX + dbW - 34" :y1="midY - 30" :x2="dbX + 34" :y2="midY + 30" />
      </g>

      <text class="lbl inst" x="0" :y="gridH + 26">instances</text>
      <text class="lbl db-lbl" :x="dbX + dbW / 2" :y="gridH + 26" text-anchor="middle">database</text>
    </svg>
    <div class="caption" :class="{ final }" :key="s">
      <span v-html="caption" />
      <span v-if="final" class="sub">It scaled the <strong>blast radius</strong>, not just the capacity.</span>
    </div>
  </div>
</template>

<style scoped>
/* Fixed width in slide-canvas px: the statement layout centers content in a shrink-to-fit
   wrapper, so width:100% would collapse to the current caption's width. */
.db-blast { width: 810px; max-width: 100%; padding-bottom: 1.5rem; }
svg { width: 100%; height: auto; display: block; }

.cell { fill: var(--c-takeaway, #d97706); opacity: 0.1; transition: opacity 0.35s ease, fill 0.4s ease; }
.cell.on { opacity: 0.9; }
.cell.dead { fill: var(--c-symptom, #e11d48); }

.funnel { fill: color-mix(in srgb, var(--c-demand, #059669) 12%, transparent); stroke: var(--c-demand, #059669); stroke-width: 3; transition: all 0.4s; }
.funnel.over { fill: color-mix(in srgb, var(--c-symptom, #e11d48) 14%, transparent); stroke: var(--c-symptom, #e11d48); }

.db { fill: color-mix(in srgb, var(--c-demand, #059669) 6%, transparent); stroke: var(--c-demand, #059669); stroke-width: 4; transition: all 0.4s; }
.db.over { stroke: var(--c-symptom, #e11d48); }
.db.dead { stroke: var(--c-symptom, #e11d48); fill: color-mix(in srgb, var(--c-symptom, #e11d48) 10%, transparent); stroke-dasharray: 10 8; }
.fill { fill: var(--c-demand, #059669); opacity: 0.8; transition: y 0.7s ease, height 0.7s ease, fill 0.4s; }
.fill.over { fill: var(--c-symptom, #e11d48); opacity: 0.9; }
.limit { stroke: var(--c-symptom, #e11d48); stroke-width: 3; stroke-dasharray: 8 6; }
.lbl-limit { font-size: 14px; font-weight: 700; fill: var(--c-symptom, #e11d48); transition: fill 0.4s; }
.lbl-limit.on { fill: #fff; }
.x line { stroke: var(--c-symptom, #e11d48); stroke-width: 10; stroke-linecap: round; }

.lbl { font-size: 17px; font-weight: 700; }
.lbl.inst { fill: var(--c-takeaway, #d97706); }
.lbl.db-lbl { fill: currentColor; opacity: 0.7; }

.caption { margin-top: 0.75rem; font-size: 1.8rem; font-weight: 700; line-height: 1.2; min-height: 7rem; animation: cap-in 0.3s ease; }
.caption.final { font-size: 2.1rem; font-weight: 800; }
.caption .sub { display: block; margin-top: 0.4rem; font-size: 1.6rem; font-weight: 600; opacity: 0.85; }
.caption :deep(strong) { color: var(--c-symptom, #e11d48); }
@keyframes cap-in { from { opacity: 0; transform: translateY(6px); } to { opacity: 1; transform: none; } }
</style>
