import { describe, expect, test } from 'vitest'
import { Sim } from './engine'
import { Pool } from './pool'

describe('Pool: acquire / queue / reject', () => {
  test('grants free slots immediately, tracks occupied', () => {
    const sim = new Sim()
    const p = new Pool(sim, { slots: 2 })
    expect(p.tryAcquire()).toBe(0)
    expect(p.occupied).toBe(1)
    expect(p.tryAcquire()).toBe(1)
    expect(p.occupied).toBe(2)
    expect(p.tryAcquire()).toBeUndefined()
  })

  test('enqueue succeeds within queueLimit, fails past it', () => {
    const sim = new Sim()
    const p = new Pool(sim, { slots: 1, queueLimit: 1 })
    p.tryAcquire()
    expect(p.enqueue(() => {})).toBe(true)
    expect(p.queued).toBe(1)
    expect(p.enqueue(() => {})).toBe(false)
    expect(p.queued).toBe(1)
  })

  test('release grants the next queued waiter, in order', () => {
    const sim = new Sim()
    const p = new Pool(sim, { slots: 1, queueLimit: 2 })
    const first = p.tryAcquire()!
    const granted: number[] = []
    p.enqueue((s) => granted.push(s))
    p.enqueue((s) => granted.push(-s - 1)) // distinguishable marker for the 2nd waiter
    p.release(first, false)
    expect(granted).toEqual([0])
    expect(p.queued).toBe(1)
    expect(p.occupied).toBe(1) // the granted waiter now occupies the slot
  })

  test('release with no queued waiter returns the slot to free', () => {
    const sim = new Sim()
    const p = new Pool(sim, { slots: 1 })
    const s = p.tryAcquire()!
    p.release(s, false)
    expect(p.occupied).toBe(0)
    expect(p.tryAcquire()).toBe(0)
  })
})

describe('Pool: poison retirement', () => {
  test('a poisoned slot never returns to free or to a queued waiter', () => {
    const sim = new Sim()
    const p = new Pool(sim, { slots: 1, queueLimit: 1 })
    const s = p.tryAcquire()!
    let granted = false
    p.enqueue(() => { granted = true })
    p.release(s, true)
    expect(granted).toBe(false)
    expect(p.tryAcquire()).toBeUndefined()
    expect(p.retired).toBe(1)
  })

  test('a poisoned slot still counts as occupied in the busy fraction', () => {
    const sim = new Sim()
    const p = new Pool(sim, { slots: 2 })
    const s = p.tryAcquire()!
    p.tryAcquire()
    p.release(s, true) // one slot poisoned, one still actively held
    expect(p.occupied).toBe(2) // both count as busy: one active, one permanently retired
  })
})

describe('Pool: busy metric', () => {
  test('busy.mean is time-weighted over occupied/slots', () => {
    const sim = new Sim()
    const p = new Pool(sim, { slots: 4 })
    const a = p.tryAcquire()!, b = p.tryAcquire()!
    sim.run(2)
    p.release(a, false)
    p.release(b, false)
    sim.run(4)
    expect(p.busy.mean).toBeCloseTo(0.25) // 0.5 occupied for 2 of 4 time units
  })

  test('forceReset zeroes occupied and busy, and clears the queue', () => {
    const sim = new Sim()
    const p = new Pool(sim, { slots: 1, queueLimit: 5 })
    p.tryAcquire()
    let granted = false
    p.enqueue(() => { granted = true })
    p.forceReset()
    expect(p.occupied).toBe(0)
    expect(p.busy.value).toBe(0)
    expect(p.queued).toBe(0)
    // the queued waiter must never fire, even if something tries to release into this pool later
    p.release(0, false)
    expect(granted).toBe(false)
  })
})
