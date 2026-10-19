import { onMounted, onUnmounted, ref, type Ref } from 'vue'

/**
 * Vertical room (in slide-canvas px) left between the top of `root` and the
 * bottom of its slide, so chart widgets can size themselves to fill the slide
 * instead of using a hand-tuned per-slide height. Measured in canvas units —
 * Slidev scales the canvas with a CSS transform, so rects are divided by the
 * scale. 0 until mounted.
 */
export function useFillHeight(root: Ref<HTMLElement | undefined>, bottomPad = 4): Ref<number> {
  const avail = ref(0)
  let ro: ResizeObserver | undefined

  function measure(): void {
    const el = root.value
    const layout = el?.closest('.slidev-layout') as HTMLElement | null
    if (!el || !layout || !layout.clientHeight) return
    const lr = layout.getBoundingClientRect()
    const scale = lr.height / layout.clientHeight || 1
    const top = (el.getBoundingClientRect().top - lr.top) / scale
    avail.value = Math.max(0, Math.floor(layout.clientHeight - top - bottomPad))
  }

  onMounted(() => {
    measure()
    const layout = root.value?.closest('.slidev-layout')
    if (layout) {
      ro = new ResizeObserver(measure)
      ro.observe(layout)
    }
    setTimeout(measure, 300) // fonts/layout settle after first paint
  })
  onUnmounted(() => ro?.disconnect())
  return avail
}

/** Extra height the last stacked panel carries for the x axis (ticks only — the unit is in the caption). */
export const LAST_PANEL_PX = 40
