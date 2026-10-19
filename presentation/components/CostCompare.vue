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
import SimCharts from './SimCharts.vue'
import { LAST_PANEL_PX, useFillHeight } from './fill'
import RunWorker from '../bench/runWorker?worker'
import type { RunRequest, RunResponse } from '../bench/runWorker'

const props = withDefaults(defineProps<{
  preset: string
  staticInstances: number
  /** Per-chart px. Omitted → fill the slide's remaining height. */
  height?: number
}>(), { height: undefined })

const root = ref<HTMLElement>()
const avail = useFillHeight(root)
// Two stacked charts; only the lower one draws the x axis + legend row (60px, see SimCharts).
const chartHeight = computed(() => props.height || Math.max(100, Math.floor((avail.value - 8 - LAST_PANEL_PX) / 2)) || 150)

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
  <div ref="root" class="cost-compare">
    <div class="cc-rows">
      <div class="cc-row">
        <div class="cc-label">Autoscaled</div>
        <SimCharts v-if="autoResult" :charts="charts" :result="autoResult" :height="chartHeight" :y-range="sharedYRange" :x-axis="false" :legend="false" />
        <div v-else class="cc-placeholder" :style="{ height: `${chartHeight}px` }"><span class="cc-spinner" /></div>
      </div>
      <div class="cc-row">
        <div class="cc-label">Static ({{ staticInstances }} instances)</div>
        <SimCharts v-if="staticResult" :charts="charts" :result="staticResult" :height="chartHeight" :y-range="sharedYRange" />
        <div v-else class="cc-placeholder" :style="{ height: `${chartHeight + LAST_PANEL_PX}px` }"><span class="cc-spinner" /></div>
      </div>
    </div>
    <div v-if="error" class="cc-error">{{ error }}</div>
    <div v-else-if="ratio" class="cc-ratio">
      <div class="cc-ratio-num">{{ ratio.toFixed(1) }}×</div>
      <div class="cc-ratio-label">the cost</div>
    </div>
  </div>
</template>

<style scoped>
.cost-compare { display: grid; grid-template-columns: 1fr auto; gap: 1rem; align-items: center; }
.cc-rows { display: flex; flex-direction: column; gap: 8px; min-width: 0; }
.cc-row { position: relative; }
.cc-row :deep(.sim-charts) { position: relative; z-index: 0; }
/* Label overlays the chart's top padding strip (left of the "load starts" marker) instead of
   taking its own row — every px of height goes to the plot. */
.cc-label { position: absolute; top: 0; right: 64px; z-index: 2; font-size: 1.1rem; font-weight: 800; }
.cc-placeholder { display: grid; place-items: center; }
.cc-spinner {
  width: 18px; height: 18px; border-radius: 50%;
  border: 2px solid var(--chart-grid, #ddd); border-top-color: var(--chart-accent, #2980b9);
  animation: spin 0.8s linear infinite;
}
@keyframes spin { to { transform: rotate(360deg); } }
.cc-ratio { text-align: center; line-height: 1; padding: 0 1rem; }
.cc-ratio-num { font-size: 5.5rem; font-weight: 800; color: var(--c-takeaway, #c0392b); }
.cc-ratio-label { margin-top: 0.4rem; font-size: 1.8rem; font-weight: 600; }
.cc-error { color: var(--c-symptom, crimson); font-family: monospace; font-size: 0.8rem; }
</style>
