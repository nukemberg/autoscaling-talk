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

class Event implements EventHandle {
  cancelled = false
  constructor(readonly t: number, readonly seq: number, readonly fn: EventFn) {}
  cancel(): void { this.cancelled = true }
}

export class Sim {
  now = 0
  private heap: Event[] = []
  private seq = 0

  /**
   * Optional progress hook: called with the current sim time during run(),
   * at most once every 4096 events plus once at the end. Overhead is nil when
   * unset. Lets callers show progress for long runs without touching determinism.
   */
  onProgress?: (now: number) => void

  /** Schedule `fn` to fire `delay` time units from now. */
  schedule(delay: number, fn: EventFn): EventHandle {
    if (delay < 0) throw new RangeError(`negative delay: ${delay}`)
    return this.scheduleAt(this.now + delay, fn)
  }

  /** Schedule `fn` to fire at absolute time `t` (must not be in the past). */
  scheduleAt(t: number, fn: EventFn): EventHandle {
    if (t < this.now) throw new RangeError(`time ${t} is before now ${this.now}`)
    const ev = new Event(t, this.seq++, fn)
    this.push(ev)
    return ev
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
      let n = 0
      while (this.step()) {
        if (this.onProgress && (++n & 0xfff) === 0) this.onProgress(this.now)
      }
      return
    }
    let n = 0
    for (;;) {
      const next = this.peek()
      if (!next || next.t > until) break
      this.step()
      if (this.onProgress && (++n & 0xfff) === 0) this.onProgress(this.now)
    }
    if (until > this.now) this.now = until
    if (this.onProgress) this.onProgress(this.now)
  }

  private peek(): Event | undefined {
    this.dropCancelled()
    return this.hlen ? this.heap[0] : undefined
  }

  private dropCancelled(): void {
    while (this.hlen && this.heap[0]!.cancelled) this.pop()
  }

  // ---- 4-ary min-heap on (t, seq) ----
  // Shallower than binary (log₄ n sifts) with better locality; the (t, seq)
  // ordering is identical, so event order is unchanged.

  // Keys live in parallel typed arrays so sift compares read contiguous doubles
  // instead of chasing Event pointers; `heap` maps position → event.
  private kt = new Float64Array(64)
  private ks = new Int32Array(64)
  private hlen = 0

  private push(ev: Event): void {
    let kt = this.kt
    if (this.hlen === kt.length) {
      const nkt = new Float64Array(kt.length * 2)
      nkt.set(kt)
      kt = this.kt = nkt
      const nks = new Int32Array(this.ks.length * 2)
      nks.set(this.ks)
      this.ks = nks
    }
    const ks = this.ks, h = this.heap
    const t = ev.t, s = ev.seq
    let i = this.hlen++
    while (i > 0) {
      const p = (i - 1) >> 2
      const pt = kt[p]!
      if (!(t < pt || (t === pt && s < ks[p]!))) break
      kt[i] = pt
      ks[i] = ks[p]!
      h[i] = h[p]!
      i = p
    }
    kt[i] = t
    ks[i] = s
    h[i] = ev
  }

  private pop(): Event | undefined {
    const hlen = this.hlen
    if (hlen === 0) return undefined
    const h = this.heap
    const top = h[0]!
    this.hlen = hlen - 1
    if (hlen > 1) {
      // Sift the last element down through the hole, moving the smallest child up each step.
      const kt = this.kt, ks = this.ks
      const n = hlen - 1
      const t = kt[n]!, s = ks[n]!
      const last = h[n]!
      let i = 0
      for (;;) {
        let c = 4 * i + 1
        if (c >= n) break
        let bc = c, bt = kt[c]!, bs = ks[c]!
        const end = c + 4 < n ? c + 4 : n
        while (++c < end) {
          const ct = kt[c]!
          if (ct < bt || (ct === bt && ks[c]! < bs)) { bt = ct; bs = ks[c]!; bc = c }
        }
        if (!(bt < t || (bt === t && bs < s))) break
        kt[i] = bt
        ks[i] = bs
        h[i] = h[bc]!
        i = bc
      }
      kt[i] = t
      ks[i] = s
      h[i] = last
    }
    return top
  }
}
