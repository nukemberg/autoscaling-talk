import { defineAppSetup } from '@slidev/types'

/**
 * Presentation-clicker keys (PageUp/PageDown already navigate):
 *  - `b`            toggle blackout (clicker "B" button)
 *  - `F5`/Shift+F5  toggle fullscreen (clicker "play" button) — and never reload the page,
 *                   which would wipe sim state mid-talk.
 * Capture phase + preventDefault so nothing else (Slidev, browser) also reacts.
 */
export default defineAppSetup(() => {
  if (typeof window === 'undefined') return
  window.addEventListener('keydown', (e) => {
    if (e.target instanceof HTMLElement && /^(INPUT|TEXTAREA|SELECT)$/.test(e.target.tagName)) return
    if (e.key === 'F5') {
      e.preventDefault()
      e.stopPropagation()
      if (e.repeat) return
      if (document.fullscreenElement) void document.exitFullscreen()
      else void document.documentElement.requestFullscreen()
    } else if (e.key === 'b' && !e.ctrlKey && !e.metaKey && !e.altKey) {
      e.preventDefault()
      e.stopPropagation()
      if (!e.repeat) document.body.classList.toggle('blackout')
    }
  }, true)
})
