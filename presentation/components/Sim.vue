<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref, watch } from 'vue'
import { resolvePreset, type Preset } from '../sim/scenarios/preset'
import type { Params, ScenarioResult } from '../sim/scenarios/types'
import RunWorker from '../bench/runWorker?worker'
import type { RunRequest, RunResponse } from '../bench/runWorker'

/**
 * Slide widget: runs a scenario from a preset (presets/<name>.json) with
 * optional overrides, shows charts, and folds the `expose`d knobs.
 *
 * Runs happen in a worker (same one the bench uses) so slides never block:
 * params changes are debounced (delay adapts to the last run's duration),
 * the last result stays visible while recalculating, and progress streams
 * back to a thin bar. Charts resize with their container.
 */
const props = withDefaults(defineProps<{
  preset: string
  params?: Params
  /** Param keys to show in the fold. Empty → no controls. */
  expose?: string[]
  height?: number
}>(), { params: () => ({}), expose: () => [], height: 180 })

const presets = import.meta.glob<Preset>('../presets/*.json', { eager: true, import: 'default' })

function load(name: string): Preset {
  const p = presets[`../presets/${name}.json`]
  if (!p) throw new Error(`unknown preset "${name}"; have: ${Object.keys(presets).join(', ')}`)
  return p
}

const resolved = computed(() => resolvePreset(load(props.preset), props.params))
const params = ref<Params>(resolved.value.params)
watch(resolved, (r) => { params.value = r.params })
const notes = computed(() => load(props.preset).notes)

const def = computed(() => resolved.value.def)

const MIN_RUN_DELAY_MS = 50
const MAX_RUN_DELAY_MS = 500
const runMs = ref(0)
const progress = ref(0)
const pending = ref(false)
const result = ref<ScenarioResult | null>(null)
const error = ref('')

const runDelayMs = computed(() =>
  Math.min(MAX_RUN_DELAY_MS, Math.max(MIN_RUN_DELAY_MS, runMs.value * 2)))

let worker: Worker | undefined
let reqId = 0

function ensureWorker(): Worker {
  if (!worker) {
    worker = new RunWorker()
    worker.onmessage = (e: MessageEvent<RunResponse>) => {
      const m = e.data
      if (m.id !== reqId) return // stale — a newer request superseded it
      if (m.type === 'progress') { progress.value = m.fraction; return }
      pending.value = false
      if (m.type === 'done') {
        result.value = m.result
        runMs.value = m.runMs
        progress.value = 1
        error.value = ''
      } else {
        error.value = m.message
      }
    }
  }
  return worker
}

function runNow(p: Params): void {
  const id = ++reqId
  pending.value = true
  progress.value = 0
  // structuredClone can't handle Vue's reactive proxies — send a plain copy
  const msg: RunRequest = { id, scenarioId: def.value.id, params: JSON.parse(JSON.stringify(p)) }
  ensureWorker().postMessage(msg)
}

let runTimer: ReturnType<typeof setTimeout> | undefined
watch(params, (p) => {
  clearTimeout(runTimer)
  // First run starts immediately; later ones wait so dragging doesn't queue up runs.
  runTimer = setTimeout(() => runNow(p), result.value ? runDelayMs.value : 0)
})
onMounted(() => runNow(params.value))
onUnmounted(() => {
  clearTimeout(runTimer)
  worker?.terminate()
})

const summary = computed(() => {
  if (error.value) return `error: ${error.value}`
  if (!result.value) return pending.value ? 'calculating…' : ''
  const s = Object.entries(result.value.summary).map(([k, v]) => `${k} ${v}`).join(' · ')
  return pending.value ? `${s} · calculating… ${(progress.value * 100).toFixed(0)}%` : s
})
</script>

<template>
  <div class="sim">
    <details v-if="expose.length || notes" class="fold">
      <summary>{{ summary }}</summary>
      <div class="panel">
        <ParamPanel v-if="expose.length" v-model="params" :specs="def.params" :only="expose" />
        <details v-if="notes" class="notes-fold">
          <summary>notes</summary>
          <p class="notes">{{ notes }}</p>
        </details>
      </div>
    </details>
    <div v-else class="summary-line">{{ summary }}</div>
    <div class="charts-wrap">
      <div class="progress" :class="{ active: pending }" aria-hidden="true">
        <div class="bar" :style="{ width: `${Math.max(2, Math.round(progress * 100))}%` }" />
      </div>
      <SimCharts v-if="result" :charts="def.charts" :result="result" :height="height" />
      <div v-else class="placeholder" :style="{ height: `${height * def.charts.length}px` }">
        <span class="spinner" />
      </div>
    </div>
  </div>
</template>

<style scoped>
.sim { display: flex; flex-direction: column; gap: 0.25rem; position: relative; isolation: isolate; }
.sim :deep(.sim-charts) { position: relative; z-index: 0; }
.fold, .summary-line { font-size: 0.75rem; font-family: monospace; }
.fold summary, .summary-line { cursor: pointer; opacity: 0.8; overflow-wrap: anywhere; }
.panel {
  position: absolute; z-index: 100; top: 1.4rem; left: 0; max-width: 100%; font-family: sans-serif;
  padding: 0.6rem 0.8rem; background: var(--chart-panel-bg, white); border: 1px solid var(--chart-panel-border, #ccc); border-radius: 4px;
  box-shadow: 0 2px 8px rgba(0,0,0,0.15);
  max-height: 70vh; overflow-y: auto; box-sizing: border-box;
}
.notes-fold { margin-top: 0.6rem; border-top: 1px solid var(--chart-grid, #ddd); padding-top: 0.4rem; }
.notes-fold summary { cursor: pointer; opacity: 0.7; font-size: 0.75rem; }
.notes-fold summary:hover { opacity: 1; }
.notes { margin: 0.4rem 0 0; font-size: 0.8rem; line-height: 1.4; color: var(--chart-text, #333); white-space: pre-wrap; min-width: 20rem; max-width: 28rem; }
.charts-wrap { position: relative; }
.progress {
  position: absolute; top: 0; left: 0; right: 0; height: 3px; z-index: 5; overflow: hidden;
  background: color-mix(in srgb, var(--chart-accent, #2980b9) 15%, transparent); opacity: 0; transition: opacity 0.15s;
}
.progress.active { opacity: 1; }
.progress .bar { height: 100%; background: var(--chart-accent, #2980b9); }
.placeholder { display: grid; place-items: center; }
.spinner {
  width: 18px; height: 18px; border-radius: 50%;
  border: 2px solid var(--chart-grid, #ddd); border-top-color: var(--chart-accent, #2980b9);
  animation: spin 0.8s linear infinite;
}
@keyframes spin { to { transform: rotate(360deg); } }
</style>