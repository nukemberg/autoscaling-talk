<script setup lang="ts">
import { computed, onMounted, ref, watch } from 'vue'
import { resolvePreset, toPreset, type Preset } from '../sim/scenarios/preset'
import { scenarios } from '../sim/scenarios/registry'
import { defaults, type ParamGroup, type Params } from '../sim/scenarios/types'

const GROUPS: ParamGroup[] = ['load', 'unit', 'scaler', 'upstream', 'fault', 'sim']
const STORAGE_KEY = 'bench.presets'

const scenarioId = ref(scenarios[0].id)
const def = computed(() => scenarios.find((s) => s.id === scenarioId.value)!)
const params = ref<Params>(defaults(def.value.params))
const name = ref('untitled')

const runMs = ref(0)
const result = computed(() => {
  const t0 = performance.now()
  const r = def.value.run(params.value)
  runMs.value = performance.now() - t0
  return r
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

const preset = computed(() => toPreset(def.value, params.value, name.value))
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
}

function newPreset() {
  params.value = defaults(def.value.params)
  let n = 1
  while (localPresets.value.some((p) => p.name === `preset ${n}`)) n++
  name.value = `preset ${n}`
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
      <div class="summary">
        <span v-for="(v, k) in result.summary" :key="k"><b>{{ k }}</b> {{ v }}</span>
        <span class="muted">{{ runMs.toFixed(0) }} ms</span>
      </div>
      <SimCharts :charts="def.charts" :result="result" :height="280" />
    </main>
  </div>
</template>

<style>
body { margin: 0; font-family: system-ui, sans-serif; font-size: 14px; color: #111; background: #fafafa; }
.bench { display: grid; grid-template-columns: 22rem 1fr; min-height: 100vh; }
aside { padding: 1rem; border-right: 1px solid #ddd; background: white; overflow-y: auto; display: flex; flex-direction: column; gap: 1rem; }
aside header h1 { margin: 0; font-size: 1rem; }
.desc { margin: 0.4rem 0 0; color: #555; font-size: 0.8rem; }
.presets { display: flex; flex-direction: column; gap: 0.4rem; font-size: 0.85rem; }
.presets select { flex: 1; }
.presets .name { flex: 1; font-size: 0.85rem; }
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
.summary { display: flex; gap: 1.5rem; font-family: monospace; }
.muted { color: #999; }
</style>
