import { describe, expect, test } from 'vitest'
import { Rng } from '../rng'
import { instanceOpts, loadParams, unitParams } from './shared'
import { defaults, type Params } from './types'

const base: Params = { ...defaults(unitParams), ...defaults(loadParams) }

describe('instanceOpts unit models', () => {
  test('loss (default): unchanged concurrency, no queue, no slowdown', () => {
    const o = instanceOpts(base, new Rng(1))
    expect(o.concurrency).toBe(base.concurrency)
    expect(o.queueLimit).toBe(0)
    expect(o.slowdown).toBeUndefined()
  })

  test('bounded-queue: exposes queueSlots as queueLimit, no slowdown', () => {
    const o = instanceOpts({ ...base, unitModel: 'bounded-queue', queueSlots: 40 }, new Rng(1))
    expect(o.concurrency).toBe(base.concurrency)
    expect(o.queueLimit).toBe(40)
    expect(o.slowdown).toBeUndefined()
  })

  test('nodejs: effectively unbounded concurrency, no queueing, slowdown grows past nominal concurrency', () => {
    const o = instanceOpts({ ...base, unitModel: 'nodejs', concurrency: 16, degradeGain: 8 }, new Rng(1))
    expect(o.concurrency).toBeGreaterThan(1000)
    expect(o.queueLimit).toBe(0)
    expect(o.slowdown).toBeDefined()
    expect(o.slowdown!(8)).toBe(1) // under nominal concurrency: no penalty
    expect(o.slowdown!(16)).toBe(1) // at nominal concurrency: no penalty
    expect(o.slowdown!(32)).toBeCloseTo(1 + 8 * 1 ** 2, 5) // 1x over nominal
    expect(o.slowdown!(48)).toBeCloseTo(1 + 8 * 2 ** 2, 5) // 2x over nominal
  })
})
