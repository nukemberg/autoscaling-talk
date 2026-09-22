import type { Sim } from './engine'
import { Tally } from './metrics'
import type { Outcome, Request } from './types'

interface Sample { t: number; latency: number; outcome: Outcome }

export interface StatsOpts {
  /** Keep the per-request log for windowed queries (default true).
   * Callers that only read `totals` can turn it off: record() then
   * allocates nothing, which matters at millions of requests. */
  track?: boolean
}

/** Completed-request log with windowed queries — what monitoring would show. */
export class Stats {
  readonly totals: Record<Outcome, number> = { ok: 0, rejected: 0, timeout: 0, error: 0 }
  private log: Sample[] | undefined

  constructor(private sim: Sim, opts: StatsOpts = {}) {
    this.log = opts.track === false ? undefined : []
  }

  record(req: Request): void {
    const outcome = req.outcome ?? 'error'
    this.totals[outcome]++
    this.log?.push({ t: this.sim.now, latency: (req.doneAt ?? this.sim.now) - req.arrivedAt, outcome })
  }

  /** Successful completions per time unit over the trailing window. */
  throughput(window: number): number {
    return this.recent(window).filter((s) => s.outcome === 'ok').length / window
  }

  /** Fraction of non-ok completions in the trailing window. */
  errorRate(window: number): number {
    const recent = this.recent(window)
    if (!recent.length) return 0
    return recent.filter((s) => s.outcome !== 'ok').length / recent.length
  }

  /** Latency tally of successful requests in the trailing window. */
  latency(window: number): Tally {
    const t = new Tally()
    for (const s of this.recent(window)) if (s.outcome === 'ok') t.add(s.latency)
    return t
  }

  private recent(window: number): Sample[] {
    const log = this.log
    if (!log) throw new Error('windowed queries need { track: true } (default) — this Stats tracks totals only')
    const from = this.sim.now - window
    // Drop anything older than the largest window we'll plausibly ask for.
    const keepFrom = this.sim.now - 10 * window
    let i = 0
    while (i < log.length && log[i]!.t < keepFrom) i++
    if (i) log.splice(0, i)
    return log.filter((s) => s.t > from)
  }
}
