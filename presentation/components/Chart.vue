<script setup lang="ts">
import type { AlignedData, Options } from 'uplot'
import uPlot from 'uplot'
import 'uplot/dist/uPlot.min.css'
import { onBeforeUnmount, onMounted, ref, shallowRef, watch } from 'vue'
import { chartColors, watchChartTheme } from './theme'

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

// Value tooltip: created lazily on first cursor move, appended directly into
// uPlot's own `u.over` element (the hover-target div exactly covering the
// plot area) so positioning needs no axis-width math of our own. Plain DOM,
// not Vue-managed — same spirit as markerHook drawing straight to canvas.
// Looked up fresh from `u.over` every call rather than cached in a component
// variable: sync's own housekeeping churns through more than one uPlot
// instance per panel behind the scenes (observed directly: a stale cached
// element's parent stopped matching the current call's `u.over`), so the
// only reliable anchor is the live instance actually handed to the hook.
function ensureTooltip(u: uPlot): HTMLDivElement {
  let tip = u.over.querySelector<HTMLDivElement>(':scope > .chart-tooltip')
  if (!tip) {
    tip = document.createElement('div')
    tip.className = 'chart-tooltip'
    u.over.appendChild(tip)
  }
  return tip
}

function fmt(v: number): string {
  return Number.isInteger(v) ? String(v) : v.toFixed(2)
}

function handleSetCursor(u: uPlot): void {
  const tip = ensureTooltip(u)
  const idx = u.cursor.idx
  if (idx == null) {
    tip.style.display = 'none'
    return
  }
  const x = u.data[0]?.[idx]
  const rows: HTMLDivElement[] = []
  for (let i = 1; i < u.series.length; i++) {
    const s = u.series[i]!
    if (s.show === false) continue
    const v = u.data[i]?.[idx]
    if (v == null) continue
    // uPlot normalizes a fixed-string stroke into a function internally at
    // some point after series creation, so a plain `typeof === 'string'`
    // check stops matching post-init — call it if it's callable, per its
    // documented (self, seriesIdx) => CanvasRenderingContext2D['strokeStyle'] shape.
    const rawStroke = typeof s.stroke === 'function' ? s.stroke(u, i) : s.stroke
    const color = typeof rawStroke === 'string' ? rawStroke : chartColors().text
    const row = document.createElement('div')
    row.className = 'row'
    const swatch = document.createElement('span')
    swatch.className = 'swatch'
    swatch.style.background = color
    const b = document.createElement('b')
    b.textContent = fmt(v)
    row.append(swatch, `${s.label ?? ''}: `, b)
    rows.push(row)
  }
  if (!rows.length || x == null) {
    tip.style.display = 'none'
    return
  }
  tip.replaceChildren()
  const xRow = document.createElement('div')
  xRow.className = 'x'
  xRow.textContent = `t=${fmt(x)}s`
  tip.append(xRow, ...rows)
  tip.style.display = 'block'
  // Fixed near the top of the plot (not tracking cursor.top): on a
  // cursor.sync'd instance the pointer usually isn't physically over this
  // panel at all, so cursor.top there is meaningless — but cursor.left is
  // kept in sync across instances and stays a true x-position.
  const left = u.cursor.left ?? 0
  const flip = left > u.bbox.width / devicePixelRatio - 140
  tip.style.left = flip ? '' : `${left + 8}px`
  tip.style.right = flip ? `${u.bbox.width / devicePixelRatio - left + 8}px` : ''
  tip.style.top = '4px'
}

// uPlot computes cursor position from real screen pixels (event.clientX
// minus a getBoundingClientRect() measurement — both correctly post-scale),
// then applies that value as a CSS `translate()` on a child of `over` for
// the crosshair — the SAME value also drives cursor.idx (data-point lookup,
// what the tooltip shows). Under a CSS `transform: scale()` ancestor
// (Slidev scales the whole slide to fit the viewport), that translate()
// gets scaled AGAIN on top of the already-post-scale distance it was
// computed from: both the crosshair's rendered position AND the data index
// it looks up drift from the real pointer position, proportionally to
// distance from the origin and to whatever Slidev is currently scaling by.
// Confirmed by direct measurement: dispatching a mousemove exactly 150px
// from a fresh rect.left rendered the crosshair 219px out — a 1.461x ratio
// matching visualWidth/offsetWidth exactly.
//
// The fix has to live in `cursor.bind.mousemove`, not the more obviously-
// named `cursor.move` hook: `cursor.move`'s output also becomes cursor.left
// for a *synced* (not actually hovered) panel receiving another panel's
// position — and that path computes its position from data VALUES via each
// panel's own scale, never from screen pixels, so it's already correct and
// applying this same correction there double-divides it. Correcting the
// raw event's clientX/clientY here, before uPlot ever converts it to a
// pixel offset, only affects genuine local mouse activity on this instance.
function filtTarg(_self: uPlot, targ: EventTarget, handle: (e: Event) => void, onlyTarg = true) {
  return (e: Event) => { if (!onlyTarg || e.target === targ) handle(e) }
}
function filtBtn0(_self: uPlot, targ: EventTarget, handle: (e: Event) => void, onlyTarg = true) {
  return (e: Event) => { if ((e as MouseEvent).button === 0 && (!onlyTarg || e.target === targ)) handle(e) }
}
function mousemoveBind(self: uPlot, targ: EventTarget, handle: (e: Event) => void) {
  return (e: MouseEvent) => {
    if (e.target !== targ) return
    const rect = self.over.getBoundingClientRect()
    const scaleX = rect.width / self.over.offsetWidth || 1
    const scaleY = rect.height / self.over.offsetHeight || 1
    const clientX = rect.left + (e.clientX - rect.left) / scaleX
    const clientY = rect.top + (e.clientY - rect.top) / scaleY
    // Proxy rather than a plain object: uPlot's internal handler may read
    // other MouseEvent members (target, buttons, preventDefault, …) we
    // don't need to know about — only clientX/clientY need correcting.
    handle(new Proxy(e, {
      get(target, prop, receiver) {
        if (prop === 'clientX') return clientX
        if (prop === 'clientY') return clientY
        const v = Reflect.get(target, prop, receiver)
        return typeof v === 'function' ? v.bind(target) : v
      },
    }))
  }
}

function buildOptions(): Options {
  const C = chartColors()
  const callerHooks = props.options?.hooks ?? {}
  // Whole-object replace, matching this file's existing convention for every
  // other option: providing options.cursor at all (e.g. SimCharts' `sync`)
  // fully defines it, including `show` defaulting to uPlot's own true —
  // only the absence of any cursor config falls back to disabled here.
  const finalCursor = props.options?.cursor ?? { show: false }
  return {
    width: el.value?.clientWidth ?? 640,
    height: props.height,
    title: props.title,
    class: 'chart-bw',
    series: [
      {},
      {
        stroke: C.text,
        width: 2,
        fill: undefined,
        points: { show: false },
      },
    ],
    axes: [
      { stroke: C.text, grid: { stroke: C.grid, width: 1 } },
      { stroke: C.text, grid: { stroke: C.grid, width: 1 } },
    ],
    scales: { x: { time: false } },
    legend: { show: false },
    ...props.options,
    cursor: {
      ...finalCursor,
      bind: {
        mousedown: filtBtn0, mouseup: filtBtn0, click: filtBtn0, dblclick: filtBtn0,
        mouseenter: filtTarg, mouseleave: filtTarg,
        mousemove: mousemoveBind,
      },
    },
    hooks: {
      ...callerHooks,
      setCursor: [...(callerHooks.setCursor ?? []), handleSetCursor],
    },
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

let ro: ResizeObserver | undefined

onMounted(() => {
  render()
  ro = new ResizeObserver(() => {
    if (chart.value && el.value)
      chart.value.setSize({ width: el.value.clientWidth, height: props.height })
  })
  if (el.value)
    ro.observe(el.value)
  watchChartTheme(render)
  watch([() => props.data, () => props.options], render)
})
onBeforeUnmount(() => {
  ro?.disconnect()
  chart.value?.destroy()
})
</script>

<template>
  <div ref="el" class="chart-container" />
</template>

<style>
.chart-bw .u-title {
  color: var(--chart-text, #1a1a1a);
  font-weight: 600;
}
.chart-bw .u-legend {
  color: var(--chart-text, #1a1a1a);
}
.chart-tooltip {
  display: none;
  position: absolute;
  z-index: 10;
  pointer-events: none;
  font-size: 0.7rem;
  line-height: 1.4;
  white-space: nowrap;
  padding: 0.3rem 0.5rem;
  border-radius: 4px;
  background: var(--chart-panel-bg, #fff);
  border: 1px solid var(--chart-panel-border, #ccc);
  box-shadow: 0 2px 6px rgba(0, 0, 0, 0.15);
  color: var(--chart-text, #1a1a1a);
}
.chart-tooltip .x {
  opacity: 0.6;
  margin-bottom: 0.15rem;
}
.chart-tooltip .row {
  display: flex;
  align-items: center;
  gap: 0.3rem;
}
.chart-tooltip .swatch {
  display: inline-block;
  width: 0.55rem;
  height: 0.55rem;
  border-radius: 2px;
  flex: none;
}
</style>
