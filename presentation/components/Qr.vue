<script setup lang="ts">
import QRCode from 'qrcode'
import { computed, ref, watchEffect } from 'vue'

/**
 * QR code for a path under the deployed slides (headmatter `baseUrl`), or a
 * full URL. `<Qr path="docs/controller-tradeoffs.md" />`, `<Qr url="https://…" />`.
 */
const props = withDefaults(defineProps<{
  path?: string
  url?: string
  size?: number
  label?: boolean
}>(), { size: 160, label: true })

const baseUrl = computed(() => String(($slidev.configs as Record<string, unknown>).baseUrl ?? '').replace(/\/$/, ''))
const href = computed(() => props.url ?? `${baseUrl.value}/${(props.path ?? '').replace(/^\//, '')}`)
const svg = ref('')

watchEffect(async () => {
  svg.value = await QRCode.toString(href.value, { type: 'svg', margin: 1, errorCorrectionLevel: 'M' })
})
</script>

<template>
  <figure class="qr">
    <div class="code" :style="{ width: `${size}px`, height: `${size}px` }" v-html="svg" />
    <figcaption v-if="label">{{ href }}</figcaption>
  </figure>
</template>

<style scoped>
.qr { display: inline-flex; flex-direction: column; align-items: center; gap: 0.3rem; margin: 0; }
.code :deep(svg) { width: 100%; height: 100%; display: block; }
figcaption { font-family: monospace; font-size: 0.65rem; opacity: 0.7; }
</style>
