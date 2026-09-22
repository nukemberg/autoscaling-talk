import { describe, expect, test } from 'vitest'
import { Sim } from './engine'

describe('Sim', () => {
  test('starts at time 0 with no events', () => {
    const sim = new Sim()
    expect(sim.now).toBe(0)
    expect(sim.step()).toBe(false)
  })

  test('schedule(delay) fires callback at now + delay', () => {
    const sim = new Sim()
    let firedAt = -1
    sim.schedule(5, () => { firedAt = sim.now })
    sim.run()
    expect(firedAt).toBe(5)
    expect(sim.now).toBe(5)
  })

  test('events fire in time order regardless of scheduling order', () => {
    const sim = new Sim()
    const order: number[] = []
    sim.schedule(10, () => order.push(10))
    sim.schedule(3, () => order.push(3))
    sim.schedule(7, () => order.push(7))
    sim.run()
    expect(order).toEqual([3, 7, 10])
  })

  test('simultaneous events fire in scheduling order (FIFO)', () => {
    const sim = new Sim()
    const order: string[] = []
    sim.schedule(1, () => order.push('a'))
    sim.schedule(1, () => order.push('b'))
    sim.schedule(1, () => order.push('c'))
    sim.run()
    expect(order).toEqual(['a', 'b', 'c'])
  })

  test('callback can schedule further events relative to current time', () => {
    const sim = new Sim()
    const times: number[] = []
    sim.schedule(2, () => {
      times.push(sim.now)
      sim.schedule(3, () => times.push(sim.now))
    })
    sim.run()
    expect(times).toEqual([2, 5])
  })

  test('cancelled event does not fire', () => {
    const sim = new Sim()
    let fired = false
    const h = sim.schedule(1, () => { fired = true })
    h.cancel()
    sim.run()
    expect(fired).toBe(false)
    expect(h.cancelled).toBe(true)
  })

  test('run(until) stops before events past until and advances clock to until', () => {
    const sim = new Sim()
    const fired: number[] = []
    sim.schedule(1, () => fired.push(1))
    sim.schedule(10, () => fired.push(10))
    sim.run(5)
    expect(fired).toEqual([1])
    expect(sim.now).toBe(5)
    sim.run()
    expect(fired).toEqual([1, 10])
  })

  test('event scheduled exactly at until fires during run(until)', () => {
    const sim = new Sim()
    let fired = false
    sim.schedule(5, () => { fired = true })
    sim.run(5)
    expect(fired).toBe(true)
  })

  test('step() processes one event and reports whether one was processed', () => {
    const sim = new Sim()
    const fired: number[] = []
    sim.schedule(1, () => fired.push(1))
    sim.schedule(2, () => fired.push(2))
    expect(sim.step()).toBe(true)
    expect(fired).toEqual([1])
    expect(sim.step()).toBe(true)
    expect(sim.step()).toBe(false)
  })

  test('negative delay throws', () => {
    const sim = new Sim()
    expect(() => sim.schedule(-1, () => {})).toThrow()
  })

  test('scheduleAt(t) fires at absolute time', () => {
    const sim = new Sim()
    let at = -1
    sim.schedule(3, () => sim.scheduleAt(8, () => { at = sim.now }))
    sim.run()
    expect(at).toBe(8)
  })

  test('handles many events (heap correctness)', () => {
    const sim = new Sim()
    const times = Array.from({ length: 5000 }, (_, i) => (i * 7919) % 1000)
    const fired: number[] = []
    for (const t of times) sim.schedule(t, () => fired.push(sim.now))
    sim.run()
    expect(fired).toEqual([...times].sort((a, b) => a - b))
  })

  test('onProgress fires coarsely with current time and once at the end', () => {
    const sim = new Sim()
    for (let i = 1; i <= 10_000; i++) sim.schedule(i, () => {})
    const calls: number[] = []
    sim.onProgress = (now) => calls.push(now)
    sim.run(10_000)
    // Throttled to once per 4096 events, plus exactly one final call at `until`.
    expect(calls.length).toBeLessThanOrEqual(3 + 1)
    expect(calls[calls.length - 1]).toBe(10_000)
    expect(calls).toEqual([...calls].sort((a, b) => a - b))
  })

  test('onProgress is silent when unset', () => {
    const sim = new Sim()
    sim.schedule(1, () => {})
    expect(() => sim.run()).not.toThrow()
  })
})
