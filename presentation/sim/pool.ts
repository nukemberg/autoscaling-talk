import type { Sim } from './engine'
import { TimeWeighted } from './metrics'

export interface PoolOpts {
  slots: number
  /** Waiting room beyond `slots`; default 0 = reject when full. */
  queueLimit?: number
  /** Probability [0,1] that a slot is permanently retired on release after
   *  use (never returned to free, never granted to a queued waiter). Models
   *  a leaked/poisoned worker — a resource that's still "occupied" in the
   *  busy metric but will never do useful work again. */
  poisonProb?: number
}

/**
 * A fixed-size resource pool: acquire a slot, hold it, release it. Beyond
 * `slots`, callers can enqueue (FIFO, bounded by `queueLimit`) or must
 * reject. Generalizes what `Instance` used to hand-roll for its worker
 * slots; the same primitive now backs CPU, worker, and connection pools.
 */
export class Pool {
  readonly busy: TimeWeighted

  private free: number[] = []
  private waiters: Array<(slot: number) => void> = []
  private readonly queueLimit: number
  private _occupied = 0
  private _retired = 0

  constructor(sim: Sim, private opts: PoolOpts) {
    this.busy = new TimeWeighted(sim, 0)
    for (let i = 0; i < opts.slots; i++) this.free.push(i)
    this.queueLimit = opts.queueLimit ?? 0
  }

  get slots(): number { return this.opts.slots }
  get occupied(): number { return this._occupied }
  get queued(): number { return this.waiters.length }
  get poisonProb(): number { return this.opts.poisonProb ?? 0 }
  /** Slots permanently lost to poisoning. */
  get retired(): number { return this._retired }

  tryAcquire(): number | undefined {
    const i = this.free.shift()
    if (i === undefined) return undefined
    this._occupied++
    this.busy.set(this._occupied / this.opts.slots)
    return i
  }

  /** Queues `onGranted` to fire once a slot frees. False if the queue is also full — caller must reject. */
  enqueue(onGranted: (slot: number) => void): boolean {
    if (this.waiters.length >= this.queueLimit) return false
    this.waiters.push(onGranted)
    return true
  }

  /** `poisoned` is rolled by the caller — Pool stays rng-free, like the rest of the sim. */
  release(slot: number, poisoned: boolean): void {
    if (poisoned) {
      this._retired++
      // occupied count is unchanged: the slot is gone, not freed — it still
      // reads as permanently busy, which is the actual observable symptom.
      return
    }
    this._occupied--
    this.busy.set(this._occupied / this.opts.slots)
    const next = this.waiters.shift()
    if (next) {
      this._occupied++
      this.busy.set(this._occupied / this.opts.slots)
      next(slot)
    } else {
      this.free.push(slot)
    }
  }

  /**
   * Owner (Instance) is discarding this pool — zero it out and drop any queued waiters, which must
   * never fire. NOTE: this intentionally does not touch `free` — the pool is meant to be abandoned,
   * not reused. Calling `release()` on a slot after `forceReset()` would decrement `_occupied` below
   * 0; nothing in this codebase does that today (only instance-owned pools get force-reset, and their
   * owning `Instance` nulls out all occupants before resetting, so no later release can reach them).
   */
  forceReset(): void {
    this._occupied = 0
    this.waiters = []
    this.busy.set(0)
  }
}
