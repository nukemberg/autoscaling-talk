<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref, watch } from 'vue'
import { resolvePreset, toPreset, type Preset } from '../sim/scenarios/preset'
import { scenarios } from '../sim/scenarios/registry'
import { defaults, type ParamGroup, type Params } from '../sim/scenarios/types'
import RunWorker from './runWorker?worker'
import type { RunRequest, RunResponse } from './runWorker'

const GROUPS: ParamGroup[] = ['load', 'unit', 'scaler', 'upstream', 'fault', 'sim']
const STORAGE_KEY = 'bench.presets'

const scenarioId = ref(scenarios[0].id)
const def = computed(() => scenarios.find((s) => s.id === scenarioId.value)!)
const params = ref<Params>(defaults(def.value.params))
const name = ref('untitled')
const notes = ref('')

// Runs happen in a worker so heavy sims never block the UI; the main thread
// only updates params (and the JSON/URL) instantly. The debounce delay adapts
// to the last run's duration — fast scenarios stay near-instant while dragging,
// slow ones wait longer so runs don't stack up in the worker's queue.
const MIN_RUN_DELAY_MS = 50
const MAX_RUN_DELAY_MS = 500
const runMs = ref(0)
const dirty = ref(false)
const progress = ref(0)
const result = ref(def.value.run(params.value))

const runDelayMs = computed(() =>
  Math.min(MAX_RUN_DELAY_MS, Math.max(MIN_RUN_DELAY_MS, runMs.value * 2)))

const worker = new RunWorker()
onUnmounted(() => worker.terminate())

let reqId = 0
worker.onmessage = (e: MessageEvent<RunResponse>) => {
  const m = e.data
  if (m.id !== reqId) return // stale run — a newer request superseded it
  if (m.type === 'progress') { progress.value = m.fraction; return }
  dirty.value = false
  if (m.type === 'done') {
    result.value = m.result
    runMs.value = m.runMs
    progress.value = 1
  } else {
    flash(`error: ${m.message}`)
  }
}

function runNow(p: Params) {
  const id = ++reqId
  // structuredClone can't handle Vue's reactive proxies — send a plain copy
  const msg: RunRequest = { id, scenarioId: def.value.id, params: JSON.parse(JSON.stringify(p)) }
  worker.postMessage(msg)
}

let runTimer: ReturnType<typeof setTimeout> | undefined
watch(params, (p) => {
  dirty.value = true
  progress.value = 0
  clearTimeout(runTimer)
  runTimer = setTimeout(() => runNow(p), runDelayMs.value)
})

const groups = computed(() => GROUPS.filter((g) => def.value.params.some((p) => p.group === g)))
const activeGroup = ref<ParamGroup>('load')

// ---- presets: repo (read-only) + local (localStorage) ----

const repoPresets = Object.entries(import.meta.glob<Preset>('../presets/*.json', { eager: true, import: 'default' }))
  .map(([path, p]) => ({ ...p, name: p.name ?? path.replace(/^.*\/(.*)\.json$/, '$1') }))

const localPresets = ref<Preset[]>(loadLocal())

function loadLocal(): Preset[] {
  try { return JSON.parse(localStorage.getItem(STORAGE_KEY) ?? '[]') } catch { return [] }
}
function persist() {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(localPresets.value))
}

const preset = computed(() => toPreset(def.value, params.value, name.value, notes.value))
const json = computed(() => JSON.stringify(preset.value, null, 2))
const isSaved = computed(() => localPresets.value.some((p) => p.name === name.value))
const status = ref('')

function flash(msg: string) {
  status.value = msg
  setTimeout(() => { status.value = '' }, 1500)
}

function applyPreset(p: Preset) {
  const r = resolvePreset(p)
  scenarioId.value = r.def.id
  params.value = r.params
  name.value = p.name ?? 'untitled'
  notes.value = p.notes ?? ''
}

function newPreset() {
  params.value = defaults(def.value.params)
  let n = 1
  while (localPresets.value.some((p) => p.name === `preset ${n}`)) n++
  name.value = `preset ${n}`
  notes.value = ''
}

function save() {
  const i = localPresets.value.findIndex((p) => p.name === name.value)
  if (i >= 0) localPresets.value[i] = preset.value
  else localPresets.value.push(preset.value)
  persist()
  flash('saved')
}

function remove() {
  localPresets.value = localPresets.value.filter((p) => p.name !== name.value)
  persist()
  flash('deleted')
}

// ---- JSON in / out ----

const pasted = ref('')

async function copy() {
  await navigator.clipboard.writeText(json.value)
  flash('copied')
}

function download() {
  const a = document.createElement('a')
  a.href = URL.createObjectURL(new Blob([json.value], { type: 'application/json' }))
  a.download = `${name.value.replace(/[^\w.-]+/g, '-')}.json`
  a.click()
  URL.revokeObjectURL(a.href)
}

function loadPasted() {
  try {
    applyPreset(JSON.parse(pasted.value))
    flash('loaded')
  } catch (e) {
    flash(`error: ${(e as Error).message}`)
  }
}

// Keep the URL in sync so a tuned state is a shareable link.
watch(preset, (p) => {
  history.replaceState(null, '', `#${encodeURIComponent(JSON.stringify(p))}`)
})
onMounted(() => {
  if (location.hash.length > 1) {
    try { applyPreset(JSON.parse(decodeURIComponent(location.hash.slice(1)))) } catch { /* ignore bad hash */ }
  }
})
</script>

<template>
  <div class="bench">
    <header class="app-header">
      <h1>SimCluster<span class="tm">™</span></h1>
      <p class="tagline">an autoscaling workbench</p>
    </header>
    <aside>
      <header>
        <h1>{{ def.title }}</h1>
        <p class="desc">{{ def.description }}</p>
      </header>

      <section class="presets">
        <div class="row">
          <select :value="''" title="Load a preset" @change="applyPreset(JSON.parse(($event.target as HTMLSelectElement).value))">
            <option value="" disabled>load preset…</option>
            <optgroup label="repo (presets/*.json)">
              <option v-for="p in repoPresets" :key="p.name" :value="JSON.stringify(p)">{{ p.name }}</option>
            </optgroup>
            <optgroup label="local (this browser)">
              <option v-for="p in localPresets" :key="p.name" :value="JSON.stringify(p)">{{ p.name }}</option>
            </optgroup>
          </select>
          <button title="Start a new preset from defaults" @click="newPreset">new</button>
        </div>
        <div class="row">
          <input v-model="name" class="name" title="Preset name (export filename)">
          <button title="Save to this browser" @click="save">{{ isSaved ? 'update' : 'save' }}</button>
          <button v-if="isSaved" title="Delete from this browser" @click="remove">delete</button>
        </div>
        <textarea
          v-model="notes" class="notes" rows="3"
          placeholder="notes: what this preset shows and why it looks the way it does — shown in the slide widget's fold"
        />
      </section>

      <nav class="tabs">
        <button v-for="g in groups" :key="g" :class="{ active: g === activeGroup }" @click="activeGroup = g">{{ g }}</button>
      </nav>
      <ParamPanel v-model="params" :specs="def.params" :groups="[activeGroup]" class="panel" />

      <section class="export">
        <div class="row">
          <button title="Copy preset JSON to clipboard" @click="copy">copy JSON</button>
          <button title="Download preset JSON — drop it into presets/ for the slides" @click="download">download</button>
          <span class="status">{{ status }}</span>
        </div>
        <pre>{{ json }}</pre>
        <textarea v-model="pasted" placeholder="paste preset JSON here" rows="3" />
        <button @click="loadPasted">load pasted</button>
      </section>
    </aside>

    <main>
      <div class="progress" :class="{ hidden: !dirty }" aria-hidden="true">
        <div class="bar" :style="{ width: `${Math.max(2, Math.round(progress * 100))}%` }" />
      </div>
      <div class="summary">
        <span v-for="(v, k) in result.summary" :key="k"><b>{{ k }}</b> {{ v }}</span>
        <span class="muted" :title="`sim re-runs ${runDelayMs.toFixed(0)} ms after the last change (adapts to run duration)`">
                {{ dirty ? `calculating… ${(progress * 100).toFixed(0)}%` : `${runMs.toFixed(0)} ms` }}
        </span>
      </div>
      <SimCharts :charts="def.charts" :result="result" :height="280" />
    </main>
  </div>
</template>

<style>
body { margin: 0; font-family: system-ui, sans-serif; font-size: 14px; color: #111; background: #fafafa; }
.bench { display: grid; grid-template-columns: 22rem 1fr; grid-template-rows: auto 1fr; min-height: 100vh; }
.app-header { grid-column: 1 / -1; padding: 0.6rem 1rem; border-bottom: 1px solid #ddd; background: white; display: flex; align-items: baseline; gap: 0.6rem; }
.app-header h1 { margin: 0; font-size: 1.1rem; letter-spacing: -0.02em; }
.app-header .tm { font-size: 0.55em; vertical-align: super; color: #999; }
.app-header .tagline { margin: 0; color: #999; font-size: 0.8rem; }
aside { padding: 1rem; border-right: 1px solid #ddd; background: white; overflow-y: auto; display: flex; flex-direction: column; gap: 1rem; }
aside header h1 { margin: 0; font-size: 1rem; }
.desc { margin: 0.4rem 0 0; color: #555; font-size: 0.8rem; }
.presets { display: flex; flex-direction: column; gap: 0.4rem; font-size: 0.85rem; }
.presets select { flex: 1; }
.presets .name { flex: 1; font-size: 0.85rem; }
.presets .notes { width: 100%; box-sizing: border-box; font-size: 0.8rem; font-family: inherit; resize: vertical; }
.row { display: flex; gap: 0.4rem; align-items: center; }
.tabs { display: flex; gap: 0.25rem; flex-wrap: wrap; }
.tabs button { padding: 0.2rem 0.6rem; border: 1px solid #ccc; background: #f4f4f4; border-radius: 3px; cursor: pointer; }
.tabs button.active { background: #2980b9; color: white; border-color: #2980b9; }
.panel { font-size: 0.85rem; }
.panel section { min-width: 100%; }
.export { display: flex; flex-direction: column; gap: 0.4rem; font-size: 0.8rem; }
.export pre { margin: 0; padding: 0.5rem; background: #f4f4f4; border-radius: 3px; max-height: 12rem; overflow: auto; font-size: 0.75rem; }
.export textarea { width: 100%; font-family: monospace; font-size: 0.75rem; box-sizing: border-box; }
.status { color: #27ae60; }
main { padding: 1rem 2rem; display: flex; flex-direction: column; gap: 0.5rem; }
.progress { height: 4px; border-radius: 2px; background: #eee; overflow: hidden; opacity: 0; transition: opacity 0.15s; }
.progress:not(.hidden) { opacity: 1; }
.progress .bar { height: 100%; background: #2980b9; }
.summary { display: flex; gap: 1.5rem; font-family: monospace; }
.muted { color: #999; }
</style>
