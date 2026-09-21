<script setup lang="ts">
import type uPlot from 'uplot'
import type { AlignedData, Options } from 'uplot'
import { computed } from 'vue'
import type { ChartSpec, ScenarioResult } from '../sim/scenarios/types'

const props = withDefaults(defineProps<{
  charts: ChartSpec[]
  result: ScenarioResult
  height?: number
}>(), { height: 180 })

const grid = { stroke: '#ddd', width: 1 }

function markerHook(labelled: boolean) {
  return (u: uPlot) => {
    const { top, height } = u.bbox
    const ctx = u.ctx
    for (const m of props.result.markers) {
      const x = u.valToPos(m.t, 'x', true)
      ctx.save()
      ctx.strokeStyle = '#2980b9'
      ctx.lineWidth = 2
      ctx.setLineDash([6, 4])
      ctx.beginPath()
      ctx.moveTo(x, top)
      ctx.lineTo(x, top + height)
      ctx.stroke()
      if (labelled) {
        ctx.setLineDash([])
        ctx.fillStyle = '#2980b9'
        ctx.font = `${12 * devicePixelRatio}px sans-serif`
        ctx.textAlign = 'right'
        ctx.fillText(m.label, x - 6 * devicePixelRatio, top + 14 * devicePixelRatio)
      }
      ctx.restore()
    }
  }
}

const panels = computed(() => props.charts.map((c, i) => {
  const last = i === props.charts.length - 1
  const data: AlignedData = [props.result.t, ...c.series.map((s) => props.result.series[s.key])]
  const options: Partial<Options> = {
    series: [
      {},
      ...c.series.map((s) => ({
        label: s.label, stroke: s.color, width: s.width ?? 1.5, points: { show: false },
        // uPlot treats an explicit `scale: undefined` differently from an absent key.
        ...(s.dash ? { dash: s.dash } : {}),
        ...(s.scale ? { scale: s.scale } : {}),
      })),
    ],
    scales: {
      x: { time: false },
      ...Object.fromEntries(Object.entries(c.scales ?? {}).map(([k, v]) => [k, { range: v.range }])),
    },
    axes: [
      last ? { stroke: 'black', grid, label: 'seconds' } : { show: false },
      { stroke: 'black', grid, label: c.yLabel },
      ...Object.entries(c.scales ?? {}).map(([k, v]) => ({
        stroke: v.color ?? 'black', side: 1, scale: k, grid: { show: false }, label: v.label,
      })),
    ],
    legend: { show: last },
    hooks: { draw: [markerHook(i === 0)] },
  }
  return { data, options, height: c.height ?? props.height }
}))
</script>

<template>
  <div class="sim-charts">
    <Chart v-for="(p, i) in panels" :key="i" :data="p.data" :options="p.options" :height="p.height" />
  </div>
</template>

<style scoped>
.sim-charts { display: flex; flex-direction: column; }
.sim-charts :deep(.u-legend) { font-size: 0.7rem; }
</style>
