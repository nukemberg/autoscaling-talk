<script setup lang="ts">
import { computed } from 'vue'
import { isActive, type ParamGroup, type ParamSpec, type Params } from '../sim/scenarios/types'

const props = defineProps<{
  specs: ParamSpec[]
  modelValue: Params
  /** Only show these keys (default: all). */
  only?: string[]
  /** Only show these groups (default: all). */
  groups?: ParamGroup[]
}>()
const emit = defineEmits<{ 'update:modelValue': [Params] }>()

const GROUP_LABEL: Record<ParamGroup, string> = {
  load: 'load', unit: 'scaling unit', scaler: 'autoscaler', upstream: 'upstream', fault: 'fault', sim: 'simulation',
}

const visible = computed(() => props.specs.filter((s) =>
  (!props.only || props.only.includes(s.key)) && (!props.groups || props.groups.includes(s.group)),
))

const grouped = computed(() => {
  const out = new Map<ParamGroup, ParamSpec[]>()
  for (const s of visible.value) (out.get(s.group) ?? out.set(s.group, []).get(s.group)!).push(s)
  return [...out.entries()]
})

function set(key: string, value: number | string | boolean) {
  emit('update:modelValue', { ...props.modelValue, [key]: value })
}

const inactive = (s: ParamSpec) => !isActive(s, props.modelValue)
</script>

<template>
  <div class="param-panel">
    <section v-for="[group, specs] in grouped" :key="group">
      <h4 v-if="grouped.length > 1">{{ GROUP_LABEL[group] }}</h4>
      <label v-for="s in specs" :key="s.key" :class="{ inactive: inactive(s) }" :title="s.help">
        <span class="name">
          {{ s.label }}<span class="info" :title="s.help">ⓘ</span>
          <b v-if="s.kind === 'range'">{{ modelValue[s.key] }}</b>
          <span v-if="s.kind === 'range' && s.unit" class="unit">{{ s.unit }}</span>
        </span>
        <input
          v-if="s.kind === 'range'" type="range" :min="s.min" :max="s.max" :step="s.step"
          :value="modelValue[s.key]" @input="set(s.key, Number(($event.target as HTMLInputElement).value))"
        >
        <select v-else-if="s.kind === 'select'" :value="modelValue[s.key]" @change="set(s.key, ($event.target as HTMLSelectElement).value)">
          <option v-for="o in s.options" :key="o.value" :value="o.value">{{ o.label }}</option>
        </select>
        <input
          v-else type="checkbox" :checked="modelValue[s.key] as boolean"
          @change="set(s.key, ($event.target as HTMLInputElement).checked)"
        >
      </label>
    </section>
  </div>
</template>

<style scoped>
.param-panel { display: flex; flex-wrap: wrap; gap: 0.6rem 1.5rem; font-size: 0.75rem; }
section { display: flex; flex-direction: column; gap: 0.35rem; min-width: 11rem; }
h4 { margin: 0 0 0.2rem; font-size: 0.7rem; text-transform: uppercase; letter-spacing: 0.05em; opacity: 0.6; }
label { display: flex; flex-direction: column; gap: 0.1rem; }
label.inactive { opacity: 0.35; }
.name { display: flex; gap: 0.3rem; align-items: baseline; }
.unit { opacity: 0.6; }
.info { opacity: 0.4; font-size: 0.9em; cursor: help; margin-right: 0.2rem; }
label:hover .info { opacity: 0.9; }
input[type=range], select { width: 100%; }
input[type=checkbox] { align-self: flex-start; }
</style>
