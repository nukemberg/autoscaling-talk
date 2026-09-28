// presentation/sim/degradation.test.ts
import { describe, expect, test } from 'vitest'
import { buildDegradation } from './degradation'

describe('buildDegradation: none', () => {
  test('always 1, regardless of outstanding', () => {
    const f = buildDegradation({ shape: 'none' })
    expect(f(0)).toBe(1)
    expect(f(1000)).toBe(1)
  })
})

describe('buildDegradation: step', () => {
  const f = buildDegradation({ shape: 'step', threshold: 10, maxFactor: 5 })

  test('1 at and below threshold', () => {
    expect(f(0)).toBe(1)
    expect(f(10)).toBe(1)
  })

  test('maxFactor above threshold', () => {
    expect(f(11)).toBe(5)
    expect(f(1000)).toBe(5)
  })
})

describe('buildDegradation: logistic', () => {
  const f = buildDegradation({ shape: 'logistic', center: 10, width: 2, maxFactor: 5 })

  test('near 1 far below center', () => {
    expect(f(0)).toBeCloseTo(1, 1)
  })

  test('halfway between 1 and maxFactor at center', () => {
    expect(f(10)).toBeCloseTo(1 + (5 - 1) / 2, 5)
  })

  test('near maxFactor far above center', () => {
    expect(f(100)).toBeCloseTo(5, 1)
  })

  test('monotonically increasing', () => {
    expect(f(5)).toBeLessThan(f(10))
    expect(f(10)).toBeLessThan(f(15))
  })
})

describe('buildDegradation: usl', () => {
  test('1 at outstanding <= 1', () => {
    const f = buildDegradation({ shape: 'usl', alpha: 0.02, beta: 0.001 })
    expect(f(0)).toBe(1)
    expect(f(1)).toBe(1)
  })

  test('grows past 1 as outstanding rises', () => {
    const f = buildDegradation({ shape: 'usl', alpha: 0.02, beta: 0.001 })
    expect(f(10)).toBeGreaterThan(1)
    expect(f(50)).toBeGreaterThan(f(10))
  })

  test('coherency term causes retrograde collapse: effective throughput (outstanding / multiplier) eventually decreases', () => {
    const f = buildDegradation({ shape: 'usl', alpha: 0.01, beta: 0.005 })
    const throughput = (o: number) => o / f(o)
    // Rises while contention/coherency costs are small, then collapses as beta's quadratic term dominates.
    expect(throughput(5)).toBeLessThan(throughput(20))
    expect(throughput(200)).toBeLessThan(throughput(20))
  })

  test('never below 1', () => {
    const f = buildDegradation({ shape: 'usl', alpha: 0, beta: 0 })
    expect(f(1000)).toBe(1)
  })
})
