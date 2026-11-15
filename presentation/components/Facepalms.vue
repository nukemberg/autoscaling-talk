<script setup lang="ts">
import { computed, onBeforeUnmount, ref, watch } from 'vue'

/**
 * The meme autoscales: once `step` reaches `startAt` (pass Slidev's `$clicks`), the facepalms
 * multiply every `everyMs` — a bigger square grid each tick: 1, 4, 9, 16, 25, 36 — and the caption appears from 16 on. Going back
 * below `startAt` resets it.
 */
const props = withDefaults(defineProps<{ src: string, step?: number, startAt?: number, everyMs?: number, maxSide?: number, caption?: string }>(),
  { step: 0, startAt: 2, everyMs: 2200, maxSide: 6 })
const side = ref(1)
const count = computed(() => side.value * side.value)
let timer: ReturnType<typeof setInterval> | undefined

function stop() { if (timer) { clearInterval(timer); timer = undefined } }
watch(() => props.step >= props.startAt, (on) => {
  stop()
  if (!on) { side.value = 1; return }
  timer = setInterval(() => {
    if (side.value >= props.maxSide) return stop()
    side.value++
  }, props.everyMs)
}, { immediate: true })
onBeforeUnmount(stop)

const cols = side
</script>

<template>
  <figure class="fp">
    <div class="grid" :style="{ gridTemplateColumns: `repeat(${cols}, 1fr)` }">
      <img v-for="i in count" :key="i" :src="src" alt="Picard facepalm">
    </div>
    <figcaption :class="{ show: count >= 16 }">{{ caption }}</figcaption>
  </figure>
</template>

<style scoped>
.fp { margin: 0; display: flex; flex-direction: column; align-items: center; gap: 0.75rem; }
.grid { display: grid; gap: 6px; width: 100%; }
.grid img { width: 100%; height: auto; display: block; border-radius: 4px; animation: pop 0.35s ease-out both; }
figcaption { font-size: 1.6rem; font-weight: 800; color: var(--c-symptom, #e11d48); opacity: 0; transition: opacity 0.4s; text-align: center; }
figcaption.show { opacity: 1; }
@keyframes pop { from { transform: scale(0.6); opacity: 0; } to { transform: scale(1); opacity: 1; } }
</style>
