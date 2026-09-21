<script setup lang="ts">
import type { AlignedData, Options } from 'uplot'
import uPlot from 'uplot'
import 'uplot/dist/uPlot.min.css'
import { onBeforeUnmount, onMounted, ref, shallowRef, watch } from 'vue'

// Sample data: CPU-driven autoscaler oscillating around a target,
// overshooting on every step because of dead time + high gain.
// x = seconds, y = instance count.
function sampleOscillation(): AlignedData {
  const n = 60
  const xs = Array.from({ length: n }, (_, i) => i * 10)
  const ys = xs.map((t) => {
    const decay = Math.exp(-t / 250)
    return 10 + 8 * decay * Math.sin(t / 25)
  })
  return [xs, ys]
}

const props = withDefaults(defineProps<{
  data?: AlignedData
  options?: Partial<Options>
  title?: string
  height?: number
}>(), {
  height: 320,
})

const chartData = () => props.data ?? sampleOscillation()

const el = ref<HTMLDivElement>()
const chart = shallowRef<uPlot>()

function buildOptions(): Options {
  return {
    width: el.value?.clientWidth ?? 640,
    height: props.height,
    title: props.title,
    class: 'chart-bw',
    series: [
      {},
      {
        stroke: 'black',
        width: 2,
        fill: undefined,
        points: { show: false },
      },
    ],
    axes: [
      { stroke: 'black', grid: { stroke: '#ddd', width: 1 } },
      { stroke: 'black', grid: { stroke: '#ddd', width: 1 } },
    ],
    scales: { x: { time: false } },
    legend: { show: false },
    cursor: { show: false },
    ...props.options,
  }
}

function render() {
  chart.value?.destroy()
  if (!el.value)
    return
  // uPlot mutates series/axes objects in place; hand it copies so props stay clean.
  const opts = buildOptions()
  opts.series = opts.series.map((s) => ({ ...s }))
  opts.axes = opts.axes?.map((a) => ({ ...a }))
  chart.value = new uPlot(opts, chartData(), el.value)
}

onMounted(render)
watch(() => [props.data, props.options], render)
onBeforeUnmount(() => chart.value?.destroy())
</script>

<template>
  <div ref="el" class="chart-container" />
</template>

<style>
.chart-bw .u-title {
  color: black;
  font-weight: 600;
}
.chart-bw .u-legend {
  color: black;
}
</style>
