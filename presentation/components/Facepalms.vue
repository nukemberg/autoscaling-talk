<script setup lang="ts">
import { computed } from 'vue'

/**
 * The meme autoscales: 1 → 4 → 16 facepalms as `step` grows (pass Slidev's `$clicks`),
 * with a caption once fully scaled out.
 */
const props = withDefaults(defineProps<{ src: string, step?: number, caption?: string }>(), { step: 0 })
const count = computed(() => (props.step >= 3 ? 16 : props.step === 2 ? 4 : 1))
const cols = computed(() => Math.sqrt(count.value))
</script>

<template>
  <figure class="fp">
    <div class="grid" :style="{ gridTemplateColumns: `repeat(${cols}, 1fr)` }">
      <img v-for="i in count" :key="`${count}-${i}`" :src="src" alt="Picard facepalm" :style="{ animationDelay: `${(i - 1) * 25}ms` }">
    </div>
    <figcaption :class="{ show: step >= 3 }">{{ caption }}</figcaption>
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
