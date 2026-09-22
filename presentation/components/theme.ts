/**
 * Theme-aware chart colors.
 *
 * The palette lives in CSS custom properties (styles/index.css) so it flips
 * with Slidev's dark/light theme. uPlot draws to canvas and can't consume
 * `var(...)` directly, so we resolve the vars to concrete color strings at
 * render time, and components re-render when the theme flips.
 *
 * Slidev imports are lazy: this module is shared with the standalone workbench
 * (bench/), which builds without Slidev's vite plugins — so `@slidev/client`
 * must only be loaded when running inside Slidev (dynamic import), never
 * statically. Outside Slidev there is no theme toggle; the palette follows
 * `prefers-color-scheme` instead.
 */
import { getCurrentScope, onScopeDispose, ref, watch } from 'vue'
export interface ChartPalette {
  /** axis strokes, title, primary series text */
  text: string
  /** de-emphasized series ("ready" ghosts) */
  muted: string
  /** event-marker verticals + labels */
  marker: string
  /** secondary-axis strokes, progress bar, spinner */
  accent: string
  /** instance-count series */
  inst: string
  /** cpu %, errors — the hot signal */
  cpu: string
  /** throughput, healthy */
  ok: string
  /** latency */
  latency: string
  /** gridlines */
  grid: string
  /** Sim panel chrome */
  panelBg: string
  panelBorder: string
}

export function chartColors(): ChartPalette {
  const v = (name: string, fallback: string) =>
    getComputedStyle(document.documentElement).getPropertyValue(name).trim() || fallback
  return {
    text: v('--chart-text', '#1a1a1a'),
    muted: v('--chart-muted', '#888'),
    marker: v('--chart-marker', '#2980b9'),
    accent: v('--chart-accent', '#2980b9'),
    inst: v('--chart-inst', '#1a1a1a'),
    cpu: v('--chart-cpu', '#c0392b'),
    ok: v('--chart-ok', '#27ae60'),
    latency: v('--chart-latency', '#8e44ad'),
    grid: v('--chart-grid', '#ddd'),
    panelBg: v('--chart-panel-bg', '#fff'),
    panelBorder: v('--chart-panel-border', '#ccc'),
  }
}

/** Resolve a palette role name to a color; literal CSS colors pass through. */
export function resolveColor(c: string | undefined, p: ChartPalette = chartColors()): string {
  if (!c) return p.text
  switch (c) {
    case 'inst': return p.inst
    case 'cpu': return p.cpu
    case 'ok': return p.ok
    case 'latency': return p.latency
    case 'muted': return p.muted
    case 'accent': return p.accent
    case 'marker': return p.marker
    case 'text': return p.text
    case 'grid': return p.grid
    default: return c // literal CSS color
  }
}

/** Reactive mirror of the host's dark-mode flag. */
const isChartDark = ref(false)

let watched = false
const themeCallbacks = new Set<() => void>()

function onScopeDisposeSafe(fn: () => void) {
  if (getCurrentScope()) onScopeDispose(fn)
}

/** Follow `prefers-color-scheme` (workbench / non-Slidev hosts). */
function watchPreferredDark() {
  if (typeof window === 'undefined' || !window.matchMedia) return
  const mq = window.matchMedia('(prefers-color-scheme: dark)')
  isChartDark.value = mq.matches
  mq.addEventListener?.('change', (e) => { isChartDark.value = e.matches })
}

/**
 * Call from a component to re-run `cb` whenever the theme flips, and once
 * immediately. Safe to call from multiple components (they share the single
 * watcher). Inside Slidev the source of truth is Slidev's dark-mode toggle;
 * elsewhere it's `prefers-color-scheme`.
 */
export function watchChartTheme(cb: () => void) {
  if (!watched) {
    watched = true
    watchPreferredDark()
    // Dynamic import: the workbench builds without Slidev's vite plugins, and
    // a static import of @slidev/client breaks its bundle (unresolved virtual
    // module `server-reactive:drawings?diff`). Inside Slidev this resolves to
    // the same module instance Slidev itself uses.
    import('@slidev/client')
      .then(({ useDarkMode }) => {
        watch(useDarkMode().isDark, (dark) => {
          isChartDark.value = dark
        }, { immediate: true })
      })
      .catch(() => { /* not inside Slidev — prefers-color-scheme already wired */ })
    watch(isChartDark, () => {
      for (const cb of themeCallbacks) cb()
    })
  }
  themeCallbacks.add(cb)
  cb()
  onScopeDisposeSafe(() => themeCallbacks.delete(cb))
}
