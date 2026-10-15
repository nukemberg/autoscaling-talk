<script setup lang="ts">
/**
 * Slide widget: runs one preset twice — once as its own autoscaled
 * self, once with min/max/initial instances pinned to a static count —
 * and stacks their "instances" panels (same y-axis bounds on both, for
 * a fair visual comparison) with the resulting cost ratio shown big.
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
}>(), { height: 150 })

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
// Just the instances/load panel — the cost panel is replaced by the single big ratio number below.
const charts = def.charts.filter((c) => c.yLabel === 'instances')

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

// Both panels share the same primary y-axis bounds (driven by the autoscaled
// side's peak, always >= the static side's flat line) so the overshoot's
// height is directly, visually comparable — not independently auto-ranged.
const sharedYRange = computed((): [number, number] | undefined => {
  if (!autoResult.value || !staticResult.value) return undefined
  const peak = Math.max(...autoResult.value.series.instances, ...staticResult.value.series.instances)
  return [0, peak * 1.1]
})

const totalCost = (r: RunResult) => Number(r.summary['total cost']?.replace('$', '') ?? NaN)
const ratio = computed(() => {
  if (!autoResult.value || !staticResult.value) return null
  return totalCost(autoResult.value) / totalCost(staticResult.value)
})
</script>

<template>
  <div class="cost-compare">
    <div class="cc-row">
      <div class="cc-label">Autoscaled</div>
      <SimCharts v-if="autoResult" :charts="charts" :result="autoResult" :height="height" :y-range="sharedYRange" />
      <div v-else class="cc-placeholder" :style="{ height: `${height}px` }"><span class="cc-spinner" /></div>
    </div>
    <div class="cc-row">
      <div class="cc-label">Static ({{ staticInstances }} instances)</div>
      <SimCharts v-if="staticResult" :charts="charts" :result="staticResult" :height="height" :y-range="sharedYRange" />
      <div v-else class="cc-placeholder" :style="{ height: `${height}px` }"><span class="cc-spinner" /></div>
    </div>
  </div>
  <div v-if="error" class="cc-error">{{ error }}</div>
  <div v-else-if="ratio" class="cc-ratio">
    <span class="cc-ratio-num">{{ ratio.toFixed(1) }}×</span>
    <span class="cc-ratio-label">the cost</span>
  </div>
</template>

<style scoped>
.cost-compare { display: flex; flex-direction: column; gap: 0.5rem; }
.cc-row :deep(.sim-charts) { position: relative; z-index: 0; }
.cc-label { font-size: 0.75rem; font-weight: 600; opacity: 0.8; margin-bottom: 0.2rem; }
.cc-placeholder { display: grid; place-items: center; }
.cc-spinner {
  width: 18px; height: 18px; border-radius: 50%;
  border: 2px solid var(--chart-grid, #ddd); border-top-color: var(--chart-accent, #2980b9);
  animation: spin 0.8s linear infinite;
}
@keyframes spin { to { transform: rotate(360deg); } }
.cc-ratio { margin-top: 0.75rem; text-align: center; line-height: 1; }
.cc-ratio-num { font-size: 3rem; font-weight: 700; color: var(--c-takeaway, #c0392b); }
.cc-ratio-label { margin-left: 0.5rem; font-size: 1.25rem; opacity: 0.8; }
.cc-error { margin-top: 0.6rem; color: var(--c-symptom, crimson); font-family: monospace; font-size: 0.8rem; }
</style>
