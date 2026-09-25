import { describe, expect, test } from 'vitest'
import { Rng } from '../rng'
import { distParams, sampleDist } from './dist'
import { defaults } from './types'

const specs = distParams({
  key: 'x', label: 'x', group: 'server', help: 'help',
  base: { min: 0, max: 100, step: 1, default: 10 },
})

describe('dist', () => {
  test('adds a base range plus dist/tail/sigma controls', () => {
    expect(specs.map((s) => s.key)).toEqual(['x', 'xDist', 'xTail', 'xSigma'])
  })

  test('fixed: returns the base exactly, never touches the rng', () => {
    const rng = new Rng(1)
    const spy = rng.next.bind(rng)
    let calls = 0
    rng.next = () => { calls++; return spy() }
    const p = { ...defaults(specs), x: 42 }
    expect(sampleDist(rng, p, 'x')).toBe(42)
    expect(sampleDist(rng, p, 'x')).toBe(42)
    expect(calls).toBe(0)
  })

  test('shifted-exp: never below the floor, tail=0 collapses to fixed', () => {
    const rng = new Rng(1)
    const p = { ...defaults(specs), x: 10, xDist: 'shifted-exp', xTail: 0 }
    expect(sampleDist(rng, p, 'x')).toBe(10)
    const withTail = { ...p, xTail: 20 }
    for (let i = 0; i < 50; i++) expect(sampleDist(rng, withTail, 'x')).toBeGreaterThanOrEqual(10)
  })

  test('shifted-exp: sample mean is roughly floor + tail', () => {
    const rng = new Rng(7)
    const p = { ...defaults(specs), x: 10, xDist: 'shifted-exp', xTail: 30 }
    const n = 5000
    let sum = 0
    for (let i = 0; i < n; i++) sum += sampleDist(rng, p, 'x')
    expect(sum / n).toBeGreaterThan(37)
    expect(sum / n).toBeLessThan(43)
  })

  test('lognormal: sigma=0 collapses to fixed', () => {
    const rng = new Rng(1)
    const p = { ...defaults(specs), x: 10, xDist: 'lognormal', xSigma: 0 }
    expect(sampleDist(rng, p, 'x')).toBe(10)
  })

  test('lognormal: median stays near base, has a right tail', () => {
    const rng = new Rng(3)
    const p = { ...defaults(specs), x: 100, xDist: 'lognormal', xSigma: 0.5 }
    const samples = Array.from({ length: 5000 }, () => sampleDist(rng, p, 'x')).sort((a, b) => a - b)
    expect(samples[2500]).toBeCloseTo(100, -1)
    expect(samples[4990]).toBeGreaterThan(200) // stragglers
  })

  test('is deterministic for a fixed seed', () => {
    const p = { ...defaults(specs), x: 10, xDist: 'shifted-exp', xTail: 20 }
    const draw = () => Array.from({ length: 10 }, () => sampleDist(new Rng(9), p, 'x'))
    expect(draw()).toEqual(draw())
  })
})
