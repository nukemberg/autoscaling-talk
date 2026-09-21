/**
 * Minimal discrete-event simulation engine.
 *
 * Events are callbacks keyed by (time, seq). Equal times fire in scheduling
 * order, which keeps runs deterministic for a fixed seed.
 */

export type EventFn = () => void

export interface EventHandle {
  readonly cancelled: boolean
  cancel(): void
}

interface Event {
  t: number
  seq: number
  fn: EventFn
  cancelled: boolean
}

export class Sim {
  now = 0
  private heap: Event[] = []
  private seq = 0

  /** Schedule `fn` to fire `delay` time units from now. */
  schedule(delay: number, fn: EventFn): EventHandle {
    if (delay < 0) throw new RangeError(`negative delay: ${delay}`)
    return this.scheduleAt(this.now + delay, fn)
  }

  /** Schedule `fn` to fire at absolute time `t` (must not be in the past). */
  scheduleAt(t: number, fn: EventFn): EventHandle {
    if (t < this.now) throw new RangeError(`time ${t} is before now ${this.now}`)
    const ev: Event = { t, seq: this.seq++, fn, cancelled: false }
    this.push(ev)
    return {
      get cancelled() { return ev.cancelled },
      cancel() { ev.cancelled = true },
    }
  }

  /** Fire the next event. Returns false when no events remain. */
  step(): boolean {
    for (;;) {
      const ev = this.pop()
      if (!ev) return false
      if (ev.cancelled) continue
      this.now = ev.t
      ev.fn()
      return true
    }
  }

  /**
   * Run until the event queue is empty or the next event is past `until`.
   * When `until` is given the clock ends at exactly `until`.
   */
  run(until?: number): void {
    if (until === undefined) {
      while (this.step()) { /* drain */ }
      return
    }
    for (;;) {
      const next = this.peek()
      if (!next || next.t > until) break
      this.step()
    }
    if (until > this.now) this.now = until
  }

  // ---- binary min-heap on (t, seq) ----

  private peek(): Event | undefined {
    this.dropCancelled()
    return this.heap[0]
  }

  private dropCancelled(): void {
    while (this.heap.length && this.heap[0].cancelled) this.pop()
  }

  private static less(a: Event, b: Event): boolean {
    return a.t < b.t || (a.t === b.t && a.seq < b.seq)
  }

  private push(ev: Event): void {
    const h = this.heap
    h.push(ev)
    let i = h.length - 1
    while (i > 0) {
      const p = (i - 1) >> 1
      if (!Sim.less(h[i], h[p])) break
      ;[h[i], h[p]] = [h[p], h[i]]
      i = p
    }
  }

  private pop(): Event | undefined {
    const h = this.heap
    if (h.length === 0) return undefined
    const top = h[0]
    const last = h.pop()!
    if (h.length > 0) {
      h[0] = last
      let i = 0
      for (;;) {
        const l = 2 * i + 1, r = l + 1
        let m = i
        if (l < h.length && Sim.less(h[l], h[m])) m = l
        if (r < h.length && Sim.less(h[r], h[m])) m = r
        if (m === i) break
        ;[h[i], h[m]] = [h[m], h[i]]
        i = m
      }
    }
    return top
  }
}
