import { describe, expect, test } from 'vitest'
import { Rng } from './rng'

describe('Rng', () => {
  test('same seed yields same sequence', () => {
    const a = new Rng(42), b = new Rng(42)
    const sa = Array.from({ length: 10 }, () => a.next())
    const sb = Array.from({ length: 10 }, () => b.next())
    expect(sa).toEqual(sb)
  })

  test('different seeds yield different sequences', () => {
    const a = new Rng(1), b = new Rng(2)
    expect(a.next()).not.toBe(b.next())
  })

  test('next() in [0,1)', () => {
    const r = new Rng(7)
    for (let i = 0; i < 10000; i++) {
      const x = r.next()
      expect(x).toBeGreaterThanOrEqual(0)
      expect(x).toBeLessThan(1)
    }
  })

  test('uniform(a,b) in [a,b) with mean ≈ midpoint', () => {
    const r = new Rng(3)
    let sum = 0
    const n = 20000
    for (let i = 0; i < n; i++) {
      const x = r.uniform(2, 4)
      expect(x).toBeGreaterThanOrEqual(2)
      expect(x).toBeLessThan(4)
      sum += x
    }
    expect(sum / n).toBeCloseTo(3, 1)
  })

  test('exp(rate) positive with mean ≈ 1/rate', () => {
    const r = new Rng(5)
    let sum = 0
    const n = 50000
    for (let i = 0; i < n; i++) {
      const x = r.exp(4)
      expect(x).toBeGreaterThan(0)
      sum += x
    }
    expect(sum / n).toBeCloseTo(0.25, 2)
  })

  test('normal(mu, sigma) mean ≈ mu, sd ≈ sigma', () => {
    const r = new Rng(9)
    const n = 50000
    let s = 0, s2 = 0
    for (let i = 0; i < n; i++) { const x = r.normal(10, 2); s += x; s2 += x * x }
    const mean = s / n
    const sd = Math.sqrt(s2 / n - mean * mean)
    expect(mean).toBeCloseTo(10, 1)
    expect(sd).toBeCloseTo(2, 1)
  })

  test('poisson(lambda) non-negative integers with mean ≈ lambda', () => {
    const r = new Rng(11)
    const n = 50000
    let s = 0
    for (let i = 0; i < n; i++) {
      const k = r.poisson(3)
      expect(Number.isInteger(k)).toBe(true)
      expect(k).toBeGreaterThanOrEqual(0)
      s += k
    }
    expect(s / n).toBeCloseTo(3, 1)
  })

  test('int(n) yields integers in [0,n) hitting every value', () => {
    const r = new Rng(13)
    const seen = new Set<number>()
    for (let i = 0; i < 1000; i++) {
      const k = r.int(5)
      expect(Number.isInteger(k)).toBe(true)
      expect(k).toBeGreaterThanOrEqual(0)
      expect(k).toBeLessThan(5)
      seen.add(k)
    }
    expect(seen.size).toBe(5)
  })
})
