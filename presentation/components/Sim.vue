<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import { resolvePreset, type Preset } from '../sim/scenarios/preset'
import type { Params } from '../sim/scenarios/types'

/**
 * Slide widget: runs a scenario from a preset (presets/<name>.json) with
 * optional overrides, shows charts, and folds the `expose`d knobs.
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

const def = computed(() => resolved.value.def)
const result = computed(() => def.value.run(params.value))
const summary = computed(() => Object.entries(result.value.summary).map(([k, v]) => `${k} ${v}`).join(' · '))
</script>

<template>
  <div class="sim">
    <details v-if="expose.length" class="fold">
      <summary>{{ summary }}</summary>
      <div class="panel">
        <ParamPanel v-model="params" :specs="def.params" :only="expose" />
      </div>
    </details>
    <div v-else class="summary-line">{{ summary }}</div>
    <SimCharts :charts="def.charts" :result="result" :height="height" />
  </div>
</template>

<style scoped>
.sim { display: flex; flex-direction: column; gap: 0.25rem; position: relative; isolation: isolate; }
.sim :deep(.sim-charts) { position: relative; z-index: 0; }
.fold, .summary-line { font-size: 0.75rem; font-family: monospace; }
.fold summary, .summary-line { cursor: pointer; opacity: 0.8; }
.panel {
  position: absolute; z-index: 100; top: 1.4rem; left: 0; max-width: 100%; font-family: sans-serif;
  padding: 0.6rem 0.8rem; background: white; border: 1px solid #ccc; border-radius: 4px;
  box-shadow: 0 2px 8px rgba(0,0,0,0.15);
}
</style>
