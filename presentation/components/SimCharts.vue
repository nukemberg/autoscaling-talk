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
        ctx.textBaseline = 'bottom'
        ctx.fillText(m.label, x - 6 * devicePixelRatio, top - 6 * devicePixelRatio)
      }
      ctx.restore()
    }
  }
}

// Fixed axis widths so stacked panels' plot areas line up — otherwise a panel with
// a secondary (right-side) scale narrows relative to one without, and left-axis
// width can drift with tick label digit count.
const LEFT_AXIS_SIZE = 56
const RIGHT_AXIS_SIZE = 50
const hasSecondary = computed(() => props.charts.some((c) => c.scales && Object.keys(c.scales).length))

const panels = computed(() => props.charts.map((c, i) => {
  const last = i === props.charts.length - 1
  const data: AlignedData = [props.result.t, ...c.series.map((s) => props.result.series[s.key])]
  // No axis `label` here (a rotated title reserves extra width beyond `size`,
  // and only a non-empty one does — that extra was the actual misalignment
  // between panels with a real secondary axis and placeholder ones below).
  // The color-coded series + legend already say what the scale is.
  const rightAxes = Object.entries(c.scales ?? {}).map(([k, v]) => ({
    stroke: v.color ?? 'black', side: 1, scale: k, grid: { show: false }, size: RIGHT_AXIS_SIZE,
  }))
  // No secondary scale of its own, but a sibling panel has one: reserve the same
  // gutter with an invisible placeholder so the plot columns still line up.
  if (!rightAxes.length && hasSecondary.value) {
    // No `scale` key: defaults to the panel's own primary scale, same as the
    // main left axis — ticks/grid stay off so nothing draws from it, only size.
    rightAxes.push({
      stroke: 'transparent', side: 1, grid: { show: false },
      size: RIGHT_AXIS_SIZE, ticks: { show: false }, values: () => [] as unknown as string[],
    })
  }
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
      { stroke: 'black', grid, label: c.yLabel, size: LEFT_AXIS_SIZE },
      ...rightAxes,
    ],
    legend: { show: last },
    hooks: { draw: [markerHook(i === 0)] },
    // Reserve room above the plot for marker labels so they don't overlap the series.
    ...(i === 0 ? { padding: [24, 8, null, null] as unknown as [number, number, number, number] } : {}),
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
