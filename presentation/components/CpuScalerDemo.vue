<script setup lang="ts">
import type { AlignedData, Options } from 'uplot'
import { computed, ref } from 'vue'
import { runCpuScenario } from '../sim/scenarios/cpu'

const rps = ref(200)
const latencyMs = ref(100)

const result = computed(() => runCpuScenario({ rps: rps.value, latencyMs: latencyMs.value }))

const data = computed<AlignedData>(() => [
  result.value.t,
  result.value.instances,
  result.value.ready,
  result.value.cpu.map((v) => v * 100),
])

const options: Partial<Options> = {
  series: [
    {},
    { label: 'instances', stroke: 'black', width: 2, points: { show: false } },
    { label: 'ready', stroke: '#888', width: 1, dash: [4, 4], points: { show: false } },
    { label: 'cpu %', stroke: '#c0392b', width: 1.5, scale: 'pct', points: { show: false } },
  ],
  scales: { x: { time: false }, pct: { range: [0, 100] } },
  axes: [
    { stroke: 'black', grid: { stroke: '#ddd', width: 1 }, label: 'seconds' },
    { stroke: 'black', grid: { stroke: '#ddd', width: 1 }, label: 'instances' },
    { stroke: '#c0392b', side: 1, scale: 'pct', grid: { show: false }, label: 'cpu %' },
  ],
  legend: { show: true },
}

const summary = computed(() => {
  const r = result.value
  return {
    peak: Math.max(...r.instances),
    final: r.instances[r.instances.length - 1],
    rejected: r.rejected[r.rejected.length - 1],
    needed: (rps.value * latencyMs.value / 1000 / 16 / 0.5).toFixed(1),
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
      <div class="summary">
        needs ≈ {{ summary.needed }} · peak {{ summary.peak }} · final {{ summary.final }} · rejected {{ summary.rejected }}
      </div>
    </div>
    <Chart :data="data" :options="options" :height="300" />
  </div>
</template>

<style scoped>
.demo { display: flex; flex-direction: column; gap: 0.5rem; }
.controls { display: flex; gap: 2rem; align-items: center; font-size: 0.8rem; }
.controls label { display: flex; flex-direction: column; min-width: 12rem; }
.controls input { width: 100%; }
.summary { opacity: 0.7; font-family: monospace; }
</style>
