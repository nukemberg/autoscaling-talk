import { describe, expect, test } from 'vitest'
import { Sim } from './engine'
import { Instance } from './instance'
import { Upstream, viaUpstream, type UpstreamOpts } from './upstream'
import type { Outcome } from './types'

const base: UpstreamOpts = { capacity: 2, serviceTime: () => 1, queueLimit: 10 }

function setup(sim: Sim, over: Partial<UpstreamOpts> = {}) {
  const up = new Upstream(sim, { ...base, ...over })
  const results: [number, Outcome][] = []
  const call = () => up.call((o) => results.push([sim.now, o]))
  return { up, results, call }
}

describe('Upstream', () => {
  test('serves up to capacity concurrently, queues the rest FIFO', () => {
    const sim = new Sim()
    const { up, results, call } = setup(sim)
    call(); call(); call()
    expect(up.inFlight).toBe(2)
    expect(up.queued).toBe(1)
    sim.run()
    expect(results).toEqual([[1, 'ok'], [1, 'ok'], [2, 'ok']])
  })

  test('queue full → error (connection refused)', () => {
    const sim = new Sim()
    const { results, call } = setup(sim, { capacity: 1, queueLimit: 0 })
    call(); call()
    expect(results).toEqual([[0, 'error']])
  })

  test('slowdown stretches service time as a function of utilization', () => {
    const sim = new Sim()
    const { results, call } = setup(sim, { capacity: 4, slowdown: (u) => 1 + u })
    call() // u = 0.25 → 1.25
    sim.run()
    expect(results[0][0]).toBeCloseTo(1.25)
  })

  test('caller timeout returns timeout but the query keeps occupying the slot', () => {
    const sim = new Sim()
    const { up, results, call } = setup(sim, { capacity: 1, serviceTime: () => 10, timeout: 3 })
    call(); call()
    sim.run(3)
    expect(results).toEqual([[3, 'timeout'], [3, 'timeout']])
    expect(up.inFlight).toBe(1)   // first query still running
    expect(up.queued).toBe(0)     // queued one gave up
    sim.run()
    expect(up.inFlight).toBe(0)
  })

  test('collapse: queue past threshold takes upstream down for recovery time, failing everything', () => {
    const sim = new Sim()
    const { up, results, call } = setup(sim, {
      capacity: 1, serviceTime: () => 10, queueLimit: 100,
      collapse: { queueThreshold: 2, recovery: 50 },
    })
    call(); call(); call() // 1 in flight, 2 queued → not yet
    expect(up.state).toBe('up')
    call()                 // 3 queued → collapse
    expect(up.state).toBe('down')
    expect(results.map((r) => r[1])).toEqual(['error', 'error', 'error', 'error'])
    call()
    expect(results.at(-1)).toEqual([0, 'error'])
    sim.run(49)
    expect(up.state).toBe('down')
    sim.run(50)
    expect(up.state).toBe('up')
    call()
    sim.run()
    expect(results.at(-1)).toEqual([60, 'ok'])
  })
})

describe('viaUpstream', () => {
  test('instance work = local time then upstream call, outcome from upstream', () => {
    const sim = new Sim()
    const { up } = setup(sim, { capacity: 1, serviceTime: () => 2 })
    const inst = new Instance(sim, {
      bootTime: 0, serviceTime: () => 0, concurrency: 5, queueLimit: 0,
      work: viaUpstream(sim, up, () => 1),
    })
    const done: [number, Outcome][] = []
    inst.onDone = (r) => done.push([r.doneAt!, r.outcome!])
    inst.handle({ id: 0, arrivedAt: 0 })
    inst.handle({ id: 1, arrivedAt: 0 })
    sim.run()
    expect(done).toEqual([[3, 'ok'], [5, 'ok']])
  })
})
