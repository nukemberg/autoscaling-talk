<script setup lang="ts">
import type uPlot from 'uplot'
import type { AlignedData, Options } from 'uplot'
import { computed, ref } from 'vue'
import { runCpuScenario } from '../sim/scenarios/cpu'

const rps = ref(200)
const latencyMs = ref(100)
const ramp = ref<'step' | 'linear' | 'logistic'>('step')
const rampSec = ref(300)

const result = computed(() => runCpuScenario({
  rps: rps.value, latencyMs: latencyMs.value, ramp: ramp.value, rampSec: rampSec.value,
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
    { label: 'offered', stroke: '#888', width: 1, dash: [4, 4], points: noPoints },
    { label: 'ok', stroke: '#27ae60', width: 2, points: noPoints },
    { label: 'failed', stroke: '#c0392b', width: 2, points: noPoints },
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
    needed: (rps.value * latencyMs.value / 1000 / 16 / 0.5).toFixed(1),
    peak: Math.max(...r.instances),
    final: r.instances[r.instances.length - 1],
    failedPct: total ? (100 * failed / total).toFixed(1) : '0',
  }
})
</script>

<template>
  <div class="demo">
    <div class="controls">
      <label>
        throughput <b>{{ rps }}</b> rps
        <input v-model.number="rps" type="range" min="10" max="1000" step="10">
      </label>
      <label>
        latency <b>{{ latencyMs }}</b> ms
        <input v-model.number="latencyMs" type="range" min="5" max="1000" step="5">
      </label>
      <label>
        ramp
        <select v-model="ramp">
          <option value="step">heaviside (step)</option>
          <option value="linear">linear</option>
          <option value="logistic">logistic</option>
        </select>
      </label>
      <label>
        ramp time <b>{{ rampSec }}</b> s
        <input v-model.number="rampSec" type="range" min="10" max="1200" step="10" :disabled="ramp === 'step'">
      </label>
    </div>
    <div class="summary">
      needs ≈ {{ summary.needed }} instances · peak {{ summary.peak }} · final {{ summary.final }} · failed {{ summary.failedPct }}%
    </div>
    <Chart :data="scalingData" :options="scalingOptions" :height="170" />
    <Chart :data="trafficData" :options="trafficOptions" :height="150" />
  </div>
</template>

<style scoped>
.demo { display: flex; flex-direction: column; gap: 0.25rem; }
.controls { display: flex; gap: 1.5rem; align-items: flex-end; font-size: 0.75rem; }
.controls label { display: flex; flex-direction: column; min-width: 9rem; }
.controls input, .controls select { width: 100%; }
.summary { opacity: 0.7; font-family: monospace; font-size: 0.75rem; }
.demo :deep(.u-legend) { font-size: 0.7rem; }
</style>
