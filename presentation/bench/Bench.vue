<script setup lang="ts">
import { computed, onMounted, ref, watch } from 'vue'
import { resolvePreset, toPreset, type Preset } from '../sim/scenarios/preset'
import { scenarios } from '../sim/scenarios/registry'
import { defaults, type ParamGroup, type Params } from '../sim/scenarios/types'

const GROUPS: ParamGroup[] = ['load', 'unit', 'scaler', 'upstream', 'sim']

const scenarioId = ref(scenarios[0].id)
const def = computed(() => scenarios.find((s) => s.id === scenarioId.value)!)
const params = ref<Params>(defaults(def.value.params))
watch(scenarioId, () => { params.value = defaults(def.value.params) })

const runMs = ref(0)
const result = computed(() => {
  const t0 = performance.now()
  const r = def.value.run(params.value)
  runMs.value = performance.now() - t0
  return r
})

const groups = computed(() => GROUPS.filter((g) => def.value.params.some((p) => p.group === g)))
const activeGroup = ref<ParamGroup>('load')

// ---- preset JSON: export / import / URL ----

const preset = computed(() => toPreset(def.value, params.value))
const json = computed(() => JSON.stringify(preset.value, null, 2))
const pasted = ref('')
const status = ref('')

function flash(msg: string) {
  status.value = msg
  setTimeout(() => { status.value = '' }, 1500)
}

async function copy() {
  await navigator.clipboard.writeText(json.value)
  flash('copied')
}

function download() {
  const a = document.createElement('a')
  a.href = URL.createObjectURL(new Blob([json.value], { type: 'application/json' }))
  a.download = `${def.value.id}.json`
  a.click()
  URL.revokeObjectURL(a.href)
}

function applyPreset(p: Preset) {
  const r = resolvePreset(p)
  scenarioId.value = r.def.id
  params.value = r.params
}

function load() {
  try {
    applyPreset(JSON.parse(pasted.value))
    flash('loaded')
  } catch (e) {
    flash(`error: ${(e as Error).message}`)
  }
}

function reset() {
  params.value = defaults(def.value.params)
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
        <select v-model="scenarioId">
          <option v-for="s in scenarios" :key="s.id" :value="s.id">{{ s.title }}</option>
        </select>
        <p class="desc">{{ def.description }}</p>
      </header>

      <nav class="tabs">
        <button v-for="g in groups" :key="g" :class="{ active: g === activeGroup }" @click="activeGroup = g">{{ g }}</button>
      </nav>
      <ParamPanel v-model="params" :specs="def.params" :groups="[activeGroup]" class="panel" />

      <section class="export">
        <div class="row">
          <button @click="copy">copy JSON</button>
          <button @click="download">download</button>
          <button @click="reset">reset</button>
          <span class="status">{{ status }}</span>
        </div>
        <pre>{{ json }}</pre>
        <textarea v-model="pasted" placeholder="paste preset JSON here" rows="4" />
        <button @click="load">load</button>
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
aside header select { width: 100%; font-size: 1rem; }
.desc { margin: 0.4rem 0 0; color: #555; font-size: 0.8rem; }
.tabs { display: flex; gap: 0.25rem; flex-wrap: wrap; }
.tabs button { padding: 0.2rem 0.6rem; border: 1px solid #ccc; background: #f4f4f4; border-radius: 3px; cursor: pointer; }
.tabs button.active { background: #2980b9; color: white; border-color: #2980b9; }
.panel { font-size: 0.85rem; }
.panel section { min-width: 100%; }
.export { display: flex; flex-direction: column; gap: 0.4rem; font-size: 0.8rem; }
.export .row { display: flex; gap: 0.4rem; align-items: center; }
.export pre { margin: 0; padding: 0.5rem; background: #f4f4f4; border-radius: 3px; max-height: 12rem; overflow: auto; font-size: 0.75rem; }
.export textarea { width: 100%; font-family: monospace; font-size: 0.75rem; box-sizing: border-box; }
.status { color: #27ae60; }
main { padding: 1rem 2rem; display: flex; flex-direction: column; gap: 0.5rem; }
.summary { display: flex; gap: 1.5rem; font-family: monospace; }
.muted { color: #999; }
</style>
