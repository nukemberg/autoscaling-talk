<script setup lang="ts">
import type uPlot from 'uplot'
import type { AlignedData, Options } from 'uplot'
import { computed, ref } from 'vue'
import type { ChartSpec, RunResult } from '../sim/scenarios/types'
import { chartColors, resolveColor, watchChartTheme } from './theme'

const props = withDefaults(defineProps<{
  charts: ChartSpec[]
  result: RunResult
  height?: number
}>(), { height: 180 })

// A factory, not a shared constant: uPlot mutates axis/grid config objects in
// place (see Chart.vue's render()), and each panel is a separate uPlot
// instance — sharing one object across panels let a later panel's instance
// corrupt an earlier one's tick state.
function mkGrid() {
  return { stroke: chartColors().grid, width: 1 }
}

// Shared across every panel's uPlot instance so hovering any one of them
// moves the crosshair (and shows each panel's own tooltip) on all of them —
// one key per SimCharts instance, stable across re-renders (panels is a
// computed that re-runs on every data/theme change, but the sync group must
// not change identity when it does).
const cursorSyncKey = `sim-charts-${Math.random().toString(36).slice(2)}`

// Zero-footprint legend: uPlot appends the legend table BELOW the canvas in
// normal flow, so an in-flow legend makes every stacked panel taller — enough
// to push the bottom panel's legend past a slide's clip edge. Instead, mount
// the table into u.over (the plot-area overlay the cursor tooltip already
// uses) and pin it to the plot's bottom-right corner, then pull it (via CSS,
// see .sim-legend below) down into the gap before the next stacked panel:
// no layout impact, and clear of the data instead of just clear of a corner.
// live:false keeps it a static marker+label row (uPlot also skips the x-axis
// row and hides value cells when not live).
function legendMount(last: boolean) {
  return (u: uPlot, legendEl: HTMLElement): void => {
    legendEl.classList.add('sim-legend')
    // The last panel also carries the x-axis tick row directly below its
    // plot square — the same negative offset that drops neatly into the
    // gap between stacked panels lands on top of those ticks here instead.
    if (last) legendEl.classList.add('sim-legend--last')
    u.over.appendChild(legendEl)
  }
}

function markerHook(labelled: boolean) {
  return (u: uPlot) => {
    const { top, height } = u.bbox
    const ctx = u.ctx
    const marker = chartColors().marker
    for (const m of props.result.markers) {
      const x = u.valToPos(m.t, 'x', true)
      ctx.save()
      ctx.strokeStyle = marker
      ctx.lineWidth = 2
      ctx.setLineDash([6, 4])
      ctx.beginPath()
      ctx.moveTo(x, top)
      ctx.lineTo(x, top + height)
      ctx.stroke()
      if (labelled) {
        ctx.setLineDash([])
        ctx.fillStyle = marker
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

// Primary y-scale always anchors at 0 and keeps a non-degenerate span, so a
// near-flat series (e.g. steady-state latency) still gets a readable axis
// with real tick spacing instead of collapsing to a single "0" label.
function yRange(_u: uPlot, dataMin: number, dataMax: number): [number, number] {
  const lo = Math.min(0, dataMin)
  const hi = Math.max(dataMax, lo + 1)
  return [lo, hi + (hi - lo) * 0.1]
}

// The 'pct' scale's static [0,100] range (declared on ChartSpec, fixed at scenario-definition
// time) only makes sense while the scaling metric is a utilization fraction. Which metric is
// actually driving the controller only settles at run() time — an absolute metric (ms, req/s)
// toggled on for this run would get silently clipped to a 0-100 window otherwise. Auto-range
// it the same way the primary axis does whenever the result says it isn't a utilization.
function pctRange(u: uPlot, dataMin: number, dataMax: number): [number, number] {
  return yRange(u, dataMin, dataMax)
}

const panelsTrigger = ref(0)
// Chart palette is read inside via chartColors(); bumping the trigger on theme
// flip re-evaluates it so every uPlot instance gets rebuilt with new colors.
const panels = computed(() => {
  void panelsTrigger.value
  const C = chartColors()
  return props.charts.map((c, i) => {
  const last = i === props.charts.length - 1
  // NaN (e.g. a controller's metric before its first sync) has to become uPlot's `null` gap
  // sentinel: uPlot's own auto-ranging scans raw values and a literal NaN poisons the whole
  // scale's min/max to NaN (unlike null, which it correctly skips), breaking any auto-ranged
  // scale — including a static-range one if it's later switched to auto-ranging (see 'pct' below).
  const data: AlignedData = [
    props.result.t,
    ...c.series.map((s) => props.result.series[s.key]?.map((v) => Number.isNaN(v) ? null : v)),
  ]
  // No axis `label` here (a rotated title reserves extra width beyond `size`,
  // and only a non-empty one does — that extra was the actual misalignment
  // between panels with a real secondary axis and placeholder ones below).
  // The color-coded series + legend already say what the scale is.
  const rightAxes = Object.entries(c.scales ?? {}).map(([k, v]) => ({
    stroke: resolveColor(v.color, C), side: 1, scale: k, grid: { show: false }, size: RIGHT_AXIS_SIZE,
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
        label: s.label, stroke: resolveColor(s.color, C), width: s.width ?? 1.5, points: { show: false },
        // uPlot treats an explicit `scale: undefined` differently from an absent key.
        ...(s.dash ? { dash: s.dash } : {}),
        ...(s.scale ? { scale: s.scale } : {}),
      })),
    ],
    scales: {
      x: { time: false },
      y: { range: yRange },
      ...Object.fromEntries(Object.entries(c.scales ?? {}).map(([k, v]) => {
        const dynamic = k === 'pct' && props.result.metricKind === 'absolute'
        // uPlot only scans series data for a scale's min/max when `auto` is true — a static
        // [min,max] range array implies auto:false (no scan needed), so switching to a range
        // *function* here also needs an explicit auto:true or it gets called with NaN,NaN.
        return [k, dynamic ? { auto: true, range: pctRange } : { range: v.range }]
      })),
    },
    axes: [
      last ? { stroke: C.text, grid: mkGrid(), label: 'seconds' } : { show: false },
      { stroke: C.text, grid: mkGrid(), label: c.yLabel, size: LEFT_AXIS_SIZE },
      ...rightAxes,
    ],
    // Minimal static legend per panel (see legendMount); only when there's
    // more than one series — a single-series panel is self-explanatory.
    legend: { show: c.series.length > 1, live: false, mount: legendMount(last) },
    cursor: { sync: { key: cursorSyncKey } },
    hooks: { draw: [markerHook(i === 0)] },
    // Reserve room above the plot for marker labels so they don't overlap the series.
    ...(i === 0 ? { padding: [24, 8, null, null] as unknown as [number, number, number, number] } : {}),
  }
  // The last panel also carries the x-axis (ticks + "seconds" label) and the
  // legend row, inside the same height budget — without extra room its own
  // plot area shrinks well below the other panels', leaving too little
  // vertical space for uPlot to fit more than one y-axis tick label.
  const LAST_PANEL_EXTRA = 60
  const height = (c.height ?? props.height) + (last ? LAST_PANEL_EXTRA : 0)
  return { data, options, height }
  })
})

// Re-evaluate `panels` (rebuilding every uPlot instance with new colors) when
// Slidev's dark/light toggle flips.
watchChartTheme(() => { panelsTrigger.value++ })
</script>

<template>
  <div class="sim-charts">
    <Chart v-for="(p, i) in panels" :key="i" :data="p.data" :options="p.options" :height="p.height" />
  </div>
</template>

<style scoped>
.sim-charts { display: flex; flex-direction: column; }
/* Minimalist legend, overlaid at the plot's bottom-right (see legendMount):
   small, one inline row, non-interactive (uPlot's click-to-toggle/isolate on
   legend labels is off so a stray click during a talk can't hide a series).
   Bottom, not top: every series here ramps up and plateaus near the top of
   its axis after load starts, so a top-corner legend sits right on top of
   the data for most of the run (worst on the latency panel, covering the
   p95 recovery dips).
   A negative bottom pulls it entirely below u.over's own box, into the
   thin gap before the next stacked panel — clear of the plot square
   altogether instead of just clear of where the data happens to be.
   The last panel has no such gap below it (the x-axis tick row sits there
   instead), so it gets a smaller offset that clears the plot without
   landing on the ticks.
   The translucent panel-bg chip keeps labels readable over data lines. */
.sim-charts :deep(.sim-legend) {
  position: absolute;
  bottom: -20px;
  right: 4px;
  /* uPlot's legend <table> defaults to width:100% (of u.over) — without this,
     the background chip below stretches across the whole panel and grays out
     every series line passing under it, not just the text. */
  width: fit-content;
  font-size: 0.65rem;
  line-height: 1.2;
  pointer-events: none;
  padding: 1px 6px;
  border-radius: 3px;
  background: color-mix(in srgb, var(--chart-panel-bg, #fff) 78%, transparent);
}
.sim-charts :deep(.sim-legend--last) { bottom: -6px; }
.sim-charts :deep(.sim-legend .u-series > *) { padding: 1px 4px; }
.sim-charts :deep(.u-marker) { height: 2px; }
</style>
