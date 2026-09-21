/**
 * Seeded PRNG (mulberry32) plus the distributions the models need.
 * Seeded so every on-stage run replays identically.
 */
export class Rng {
  private state: number

  constructor(seed: number) {
    this.state = seed >>> 0
  }

  /** Uniform in [0, 1). */
  next(): number {
    let t = (this.state += 0x6d2b79f5)
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }

  /** Uniform in [a, b). */
  uniform(a: number, b: number): number {
    return a + (b - a) * this.next()
  }

  /** Integer in [0, n). */
  int(n: number): number {
    return Math.floor(this.next() * n)
  }

  /** Exponential with the given rate (mean 1/rate). */
  exp(rate: number): number {
    // 1 - next() is in (0, 1], so log never sees 0.
    return -Math.log(1 - this.next()) / rate
  }

  /** Normal via Box–Muller. */
  normal(mu = 0, sigma = 1): number {
    const u = 1 - this.next()
    const v = this.next()
    return mu + sigma * Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v)
  }

  /** Poisson count via Knuth's method (fine for small lambda). */
  poisson(lambda: number): number {
    const limit = Math.exp(-lambda)
    let k = 0
    let p = 1
    do {
      k++
      p *= this.next()
    } while (p > limit)
    return k - 1
  }
}
