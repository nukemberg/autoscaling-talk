<script setup lang="ts">
import type uPlot from 'uplot'
import type { AlignedData, Options } from 'uplot'
import { computed, ref } from 'vue'
import { runCpuScenario } from '../sim/scenarios/cpu'

const LATENCY_MS = 100          // fixed: 16 slots × 10 req/s = 160 rps per instance
const PER_INSTANCE = 16 * 1000 / LATENCY_MS
const TARGET = 0.5

const baseRps = ref(100)
const rps = ref(400)
const ramp = ref<'step' | 'linear' | 'logistic'>('step')
const rampSec = ref(300)

const result = computed(() => runCpuScenario({
  rps: rps.value, baseRps: baseRps.value, latencyMs: LATENCY_MS, ramp: ramp.value, rampSec: rampSec.value,
}))

const scalingData = computed<AlignedData>(() => [
  result.value.t,
  result.value.instances,
  result.value.ready,
  result.value.cpu.map((v) => v * 100),
])

const trafficData = computed<AlignedData>(() => [
  result.value.t,
  result.value.offeredRps,
  result.value.okRps,
  result.value.failedRps,
])

const grid = { stroke: '#ddd', width: 1 }
const noPoints = { show: false }
const QUIET_SEC = 300

/** Vertical marker where load starts, so the before/after is obvious. */
function loadStartMarker(label?: string) {
  return {
    draw: [(u: uPlot) => {
      const x = u.valToPos(QUIET_SEC, 'x', true)
      const { top, height } = u.bbox
      const ctx = u.ctx
      ctx.save()
      ctx.strokeStyle = '#2980b9'
      ctx.lineWidth = 2
      ctx.setLineDash([6, 4])
      ctx.beginPath()
      ctx.moveTo(x, top)
      ctx.lineTo(x, top + height)
      ctx.stroke()
      if (label) {
        ctx.setLineDash([])
        ctx.fillStyle = '#2980b9'
        ctx.font = `${12 * devicePixelRatio}px sans-serif`
        ctx.textAlign = 'right'
        ctx.fillText(label, x - 6 * devicePixelRatio, top + 14 * devicePixelRatio)
      }
      ctx.restore()
    }],
  }
}

const scalingOptions: Partial<Options> = {
  series: [
    {},
    { label: 'instances', stroke: 'black', width: 2, points: noPoints },
    { label: 'ready', stroke: '#888', width: 1, dash: [4, 4], points: noPoints },
    { label: 'cpu %', stroke: '#c0392b', width: 1.5, scale: 'pct', points: noPoints },
  ],
  scales: { x: { time: false }, pct: { range: [0, 100] } },
  axes: [
    { show: false },
    { stroke: 'black', grid, label: 'instances' },
    { stroke: '#c0392b', side: 1, scale: 'pct', grid: { show: false }, label: 'cpu %' },
  ],
  legend: { show: false },
  hooks: loadStartMarker('load starts →'),
}

const trafficOptions: Partial<Options> = {
  series: [
    {},
    { label: 'incoming', stroke: '#888', width: 1, dash: [4, 4], points: noPoints },
    { label: 'OK', stroke: '#27ae60', width: 2, points: noPoints },
    { label: 'errors', stroke: '#c0392b', width: 2, points: noPoints },
  ],
  scales: { x: { time: false } },
  axes: [
    { stroke: 'black', grid, label: 'seconds' },
    { stroke: 'black', grid, label: 'req/s' },
  ],
  legend: { show: true },
  hooks: loadStartMarker(),
}

const summary = computed(() => {
  const r = result.value
  const total = r.okRps.reduce((a, b) => a + b, 0) + r.failedRps.reduce((a, b) => a + b, 0)
  const failed = r.failedRps.reduce((a, b) => a + b, 0)
  return {
    needed: (rps.value / PER_INSTANCE / TARGET).toFixed(1),
    peak: Math.max(...r.instances),
    final: r.instances[r.instances.length - 1],
    errorPct: total ? (100 * failed / total).toFixed(1) : '0',
  }
})
</script>

<template>
  <div class="demo">
    <details class="controls">
      <summary>
        base {{ baseRps }} → {{ rps }} rps · {{ ramp }}<span v-if="ramp !== 'step'"> over {{ rampSec }}s</span>
        · needs ≈ {{ summary.needed }} · peak {{ summary.peak }} · final {{ summary.final }} · errors {{ summary.errorPct }}%
      </summary>
      <div class="panel">
        <label>
          <span>base load <b>{{ baseRps }}</b> rps</span>
          <input v-model.number="baseRps" type="range" min="0" max="1000" step="10">
        </label>
        <label>
          <span>load after ramp <b>{{ rps }}</b> rps</span>
          <input v-model.number="rps" type="range" min="10" max="2000" step="10">
        </label>
        <label>
          <span>ramp</span>
          <select v-model="ramp">
            <option value="step">heaviside (step)</option>
            <option value="linear">linear</option>
            <option value="logistic">logistic</option>
          </select>
        </label>
        <label>
          <span>ramp time <b>{{ rampSec }}</b> s</span>
          <input v-model.number="rampSec" type="range" min="10" max="1200" step="10" :disabled="ramp === 'step'">
        </label>
        <div class="fixed-params">
          fixed: {{ LATENCY_MS }} ms/req · 16 slots → {{ PER_INSTANCE }} rps/instance · target CPU {{ TARGET * 100 }}% · boot 120 s · period 30 s · window 60 s
        </div>
      </div>
    </details>
    <Chart :data="scalingData" :options="scalingOptions" :height="190" />
    <Chart :data="trafficData" :options="trafficOptions" :height="170" />
  </div>
</template>

<style scoped>
.demo { display: flex; flex-direction: column; gap: 0.25rem; position: relative; }
.controls { font-size: 0.75rem; }
.controls summary { cursor: pointer; font-family: monospace; opacity: 0.8; }
.panel {
  position: absolute; z-index: 10; top: 1.4rem; left: 0;
  display: grid; grid-template-columns: repeat(4, 11rem); gap: 0.6rem 1.2rem;
  padding: 0.6rem 0.8rem; background: white; border: 1px solid #ccc; border-radius: 4px;
  box-shadow: 0 2px 8px rgba(0,0,0,0.15);
}
.panel label { display: flex; flex-direction: column; gap: 0.2rem; }
.panel input, .panel select { width: 100%; }
.fixed-params { grid-column: 1 / -1; opacity: 0.6; font-family: monospace; font-size: 0.7rem; }
.demo :deep(.u-legend) { font-size: 0.7rem; }
</style>
