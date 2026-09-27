import { describe, expect, test } from 'vitest'
import { Clients, type ClientsOpts } from './clients'
import { Sim } from './engine'
import { Rng } from './rng'
import type { Outcome, Request } from './types'

/**
 * Minimal downstream: records each attempt and returns a `finish` handle.
 * Completion is explicit, so tests control exactly when/how attempts resolve.
 */
function harness(opts: Partial<ClientsOpts> = {}) {
  const sim = new Sim()
  const inFlight = new Map<Request, (o: Outcome) => void>()
  const done: Request[] = []
  const clients = new Clients(sim, {
    ...opts,
    sink: (r) => inFlight.set(r, (o) => { r.doneAt = sim.now; r.outcome = o; clients.observe(r) }),
    onDone: (r) => done.push(r),
  })
  return {
    sim, clients, done, inFlight,
    /** Complete one in-flight attempt (FIFO). */
    finish(o: Outcome): void {
      const [r, f] = inFlight.entries().next().value!
      inFlight.delete(r)
      f(o)
    },
    fresh: (id = 0): Request => ({ id, arrivedAt: sim.now }),
  }
}

describe('Clients', () => {
  test('no retries configured: pure pass-through', () => {
    const h = harness({})
    h.clients.handle(h.fresh())
    h.finish('ok')
    expect(h.done).toHaveLength(1)
    expect(h.done[0].outcome).toBe('ok')
    expect(h.clients.attempts).toBe(1)
    expect(h.clients.retries).toBe(0)
  })

  test('retries on error until success; latency spans all attempts', () => {
    const h = harness({ maxRetries: 2 })
    const r = h.fresh()
    h.clients.handle(r)
    h.finish('error')
    h.sim.run(0) // immediate retry = a same-time event
    expect(h.clients.inFlight).toBe(1) // re-sent immediately (no delay)
    expect(h.clients.attempts).toBe(2)
    h.finish('error')
    h.sim.run(0)
    expect(h.clients.attempts).toBe(3)
    h.sim.run(10)
    h.finish('ok')
    expect(h.done).toHaveLength(1)
    expect(h.done[0].outcome).toBe('ok')
    expect(h.done[0].attempt).toBe(2)
    expect(h.done[0].arrivedAt).toBe(0) // original arrival, end-to-end latency
    expect(h.clients.retries).toBe(2)
  })

  test('exhausted retries deliver the final failure once', () => {
    const h = harness({ maxRetries: 1 })
    h.clients.handle(h.fresh())
    h.finish('error')
    h.sim.run(0)
    h.finish('error')
    expect(h.done).toHaveLength(1)
    expect(h.done[0].outcome).toBe('error')
    expect(h.clients.delivered).toBe(1)
  })

  test("'rejected' is not retried by default", () => {
    const h = harness({ maxRetries: 3 })
    h.clients.handle(h.fresh())
    h.finish('rejected')
    expect(h.done).toHaveLength(1)
    expect(h.clients.attempts).toBe(1)
  })

  test("'rejected' is retried when listed in retryOn", () => {
    const h = harness({ maxRetries: 3, retryOn: ['error', 'timeout', 'rejected'] })
    h.clients.handle(h.fresh())
    h.finish('rejected')
    h.sim.run(0)
    expect(h.clients.attempts).toBe(2)
    h.finish('ok')
    expect(h.done[0].outcome).toBe('ok')
  })

  test('client timeout abandons the attempt, which keeps running server-side', () => {
    const h = harness({ timeout: 10, maxRetries: 5 })
    h.clients.handle(h.fresh())
    const [first] = h.inFlight.keys()
    h.sim.run(10) // timeout fires; attempt still in the fake server
    expect(h.clients.timeouts).toBe(1)
    expect(h.clients.attempts).toBe(2) // retry already issued (delay 0 → same-time event)
    expect(h.inFlight.size).toBe(2) // abandoned original + the retry
    // The abandoned attempt completes late: swallowed, invisible to onDone.
    h.clients.observe(first)
    expect(h.clients.abandoned).toBe(1)
    expect(h.done).toHaveLength(0)
    // The retry succeeds → delivered.
    const f = h.inFlight.get([...h.inFlight.keys()].find((r) => r !== first)!)!
    f('ok')
    expect(h.done).toHaveLength(1)
    expect(h.done[0].outcome).toBe('ok')
    expect(h.done[0].attempt).toBe(1)
  })

  test('timeout with no retries left: final timeout at give-up time', () => {
    const h = harness({ timeout: 10 })
    h.clients.handle(h.fresh())
    h.sim.run(10)
    expect(h.done).toHaveLength(1)
    expect(h.done[0].outcome).toBe('timeout')
    expect(h.done[0].doneAt).toBe(10)
    expect(h.clients.timeouts).toBe(1)
    // Late completion of the abandoned attempt is swallowed.
    const [late, f] = h.inFlight.entries().next().value!
    f('ok')
    expect(h.clients.abandoned).toBe(1)
    expect(h.done).toHaveLength(1)
    void late
  })

  test('retry delay + exponential backoff', () => {
    const h = harness({ maxRetries: 3, retryDelay: 10, backoff: 2 })
    h.clients.handle(h.fresh())
    h.finish('error')
    h.sim.run(9) // run() takes an absolute time
    expect(h.clients.attempts).toBe(1) // first retry waits 10ms
    h.sim.run(10)
    expect(h.clients.attempts).toBe(2)
    h.finish('error')
    h.sim.run(29)
    expect(h.clients.attempts).toBe(2) // second retry waits 20ms (backoff)
    h.sim.run(30)
    expect(h.clients.attempts).toBe(3)
  })

  test('jitter bounds the retry delay deterministically', () => {
    const h = harness({ maxRetries: 1, retryDelay: 100, jitterFrac: 0.5, rng: new Rng(7) })
    h.clients.handle(h.fresh())
    h.finish('error')
    h.sim.run(49)
    expect(h.clients.attempts).toBe(1)
    h.sim.run(101)
    expect(h.clients.attempts).toBe(2) // fired within [50, 150]
  })

  test('jitterFrac without rng is rejected', () => {
    const sim = new Sim()
    expect(() => new Clients(sim, { sink: () => {}, onDone: () => {}, jitterFrac: 0.5 })).toThrow(/rng/)
  })

  test('retry storm: retries multiply load under failure', () => {
    // 10 clients × 3 attempts each against a sink that always errors.
    const h = harness({ maxRetries: 2 })
    for (let i = 0; i < 10; i++) h.clients.handle(h.fresh(i))
    h.sim.run(1)
    for (let i = 0; i < 10; i++) h.finish('error')
    h.sim.run(1)
    for (let i = 0; i < 10; i++) h.finish('error')
    h.sim.run(1)
    for (let i = 0; i < 10; i++) h.finish('error')
    expect(h.clients.attempts).toBe(30)
    expect(h.clients.retries).toBe(20)
    expect(h.clients.delivered).toBe(10)
    expect(h.done.every((r) => r.outcome === 'error')).toBe(true)
  })
})
