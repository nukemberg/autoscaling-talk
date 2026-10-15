<script setup lang="ts">
/**
 * Slide widget: runs one preset twice — once as its own autoscaled
 * self, once with min/max/initial instances pinned to a static count —
 * and shows the "instances" and "cumulative $" panels for each side by
 * side, plus the resulting cost ratio.
 *
 * Both runs happen in the same worker Sim.vue uses, off the main thread,
 * once on mount — there's no knob panel here, so no re-run debounce needed.
 */
import { computed, onMounted, onUnmounted, ref } from 'vue'
import { resolvePreset, type Preset } from '../sim/scenarios/preset'
import type { RunResult } from '../sim/scenarios/types'
import RunWorker from '../bench/runWorker?worker'
import type { RunRequest, RunResponse } from '../bench/runWorker'

const props = withDefaults(defineProps<{
  preset: string
  staticInstances: number
  height?: number
}>(), { height: 130 })

const presets = import.meta.glob<Preset>('../presets/*.json', { eager: true, import: 'default' })

function load(name: string): Preset {
  const p = presets[`../presets/${name}.json`]
  if (!p) throw new Error(`unknown preset "${name}"; have: ${Object.keys(presets).join(', ')}`)
  return p
}

const { def, params } = resolvePreset(load(props.preset))
const staticParams = {
  ...params,
  minInstances: props.staticInstances, maxInstances: props.staticInstances, initialInstances: props.staticInstances,
}
const charts = def.charts.filter((c) => c.yLabel === 'instances' || c.yLabel === 'cumulative $')

const autoResult = ref<RunResult | null>(null)
const staticResult = ref<RunResult | null>(null)
const error = ref('')

let worker: Worker | undefined

onMounted(() => {
  worker = new RunWorker()
  worker.onmessage = (e: MessageEvent<RunResponse>) => {
    const m = e.data
    if (m.type === 'error') { error.value = m.message; return }
    if (m.type !== 'done') return
    if (m.id === 1) autoResult.value = m.result
    else if (m.id === 2) staticResult.value = m.result
  }
  const send = (id: number, p: typeof params): void => {
    const msg: RunRequest = { id, modelId: def.id, params: JSON.parse(JSON.stringify(p)) }
    worker!.postMessage(msg)
  }
  send(1, params)
  send(2, staticParams)
})
onUnmounted(() => worker?.terminate())

const totalCost = (r: RunResult) => Number(r.summary['total cost']?.replace('$', '') ?? NaN)
const ratio = computed(() => {
  if (!autoResult.value || !staticResult.value) return null
  const auto = totalCost(autoResult.value), stat = totalCost(staticResult.value)
  return { auto, stat, times: auto / stat }
})
</script>

<template>
  <div class="cost-compare">
    <div class="cc-col">
      <div class="cc-label">Autoscaled</div>
      <SimCharts v-if="autoResult" :charts="charts" :result="autoResult" :height="height" />
      <div v-else class="cc-placeholder" :style="{ height: `${height * charts.length}px` }"><span class="cc-spinner" /></div>
    </div>
    <div class="cc-col">
      <div class="cc-label">Static ({{ staticInstances }} instances)</div>
      <SimCharts v-if="staticResult" :charts="charts" :result="staticResult" :height="height" />
      <div v-else class="cc-placeholder" :style="{ height: `${height * charts.length}px` }"><span class="cc-spinner" /></div>
    </div>
  </div>
  <div v-if="error" class="cc-error">{{ error }}</div>
  <div v-else-if="ratio" class="cc-ratio">
    ${{ ratio.auto.toFixed(2) }} autoscaled vs ${{ ratio.stat.toFixed(2) }} static —
    <strong>{{ ratio.times.toFixed(1) }}×</strong> the cost
  </div>
</template>

<style scoped>
.cost-compare { display: grid; grid-template-columns: 1fr 1fr; gap: 0.75rem; }
.cc-col :deep(.sim-charts) { position: relative; z-index: 0; }
.cc-label { font-size: 0.75rem; font-weight: 600; opacity: 0.8; margin-bottom: 0.2rem; }
.cc-placeholder { display: grid; place-items: center; }
.cc-spinner {
  width: 18px; height: 18px; border-radius: 50%;
  border: 2px solid var(--chart-grid, #ddd); border-top-color: var(--chart-accent, #2980b9);
  animation: spin 0.8s linear infinite;
}
@keyframes spin { to { transform: rotate(360deg); } }
.cc-ratio { margin-top: 0.6rem; font-size: 1rem; text-align: center; }
.cc-ratio strong { color: var(--c-takeaway, inherit); }
.cc-error { margin-top: 0.6rem; color: var(--c-symptom, crimson); font-family: monospace; font-size: 0.8rem; }
</style>
