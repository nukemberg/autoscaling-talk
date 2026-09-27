import type { EventHandle, Sim } from './engine'
import type { Rng } from './rng'
import type { Outcome, Request, Sink } from './types'

export interface ClientsOpts {
  /** Where an attempt is sent — usually the load balancer. */
  sink: Sink
  /** Final, client-observed completion of a logical request: fired once, when
   *  the last attempt resolves or the client gives up entirely. Not fired for
   *  abandoned attempts (the client already stopped waiting for those). */
  onDone: (req: Request) => void
  /**
   * Client-side timeout per attempt. On expiry the client abandons the attempt
   * and (retries permitting) re-sends later — but the attempt keeps running
   * server-side, holding its resources until it completes or the server gives
   * up. That's the amplification: timeouts multiply load without freeing any.
   * 0 = clients wait forever (default).
   */
  timeout?: number
  /** How many times a logical request is re-sent after the first attempt. 0 = fire once. */
  maxRetries?: number
  /** Base wait before re-sending. Default 0 = immediate retry — every client
   *  that failed hits again at the same moment (the thundering herd). */
  retryDelay?: number
  /** Which failed outcomes trigger a retry. Default `['error', 'timeout']` —
   *  external clients retry errors and timeouts; `rejected` (503) is not
   *  retried unless listed here. */
  retryOn?: Outcome[]
  /** Retry delay multiplies by this per attempt (default 1 = fixed delay). */
  backoff?: number
  /** Bounded multiplicative jitter on the retry delay, ±fraction (0 = none).
   *  Jitter is what de-syncs a herd: without it, every timed-out client fires
   *  again in the same instant. */
  jitterFrac?: number
  /** RNG for jitter. Required when `jitterFrac > 0`. */
  rng?: Rng
}

/** One logical request as currently tracked: the in-flight attempt, budget left. */
interface Pending {
  /** The current attempt's request object — fresh per attempt, `arrivedAt`
   *  kept from the original arrival so recorded latency stays end-to-end. */
  req: Request
  attempt: number
  retriesLeft: number
  timer?: EventHandle
}

/**
 * External clients between the load source and the LB. Unlike internal
 * resources (pools, upstream) these are NOT under our control: we can ask
 * callers nicely to add jitter, back off, or set sane timeouts, but the sim
 * runs whatever policy they actually ship. Retries multiply offered load by
 * roughly (1 + retries) under failure and pile abandoned attempts on the
 * servers — the thundering herd.
 */
export class Clients {
  /** Attempts sent downstream, including retries. */
  attempts = 0
  /** Attempts that were retries (subset of `attempts`). */
  retries = 0
  /** Attempts the client gave up on via timeout (the server kept working on them). */
  timeouts = 0
  /** Abandoned attempts that completed later — their outcome is swallowed. */
  abandoned = 0
  /** Logical requests fully resolved (success, final failure, or gave up entirely). */
  delivered = 0

  private pending = new Map<Request, Pending>()

  /** Attempts awaiting completion (excludes the retry-wait gaps). */
  get inFlight(): number { return this.pending.size }

  constructor(private sim: Sim, private opts: ClientsOpts) {
    if ((opts.jitterFrac ?? 0) > 0 && !opts.rng) throw new Error('Clients: jitterFrac requires an rng')
  }

  /** Entry point for the load source (wire Arrivals here instead of the LB). */
  handle(req: Request): void {
    const maxRetries = this.opts.maxRetries ?? 0
    this.pending.set(req, { req, attempt: 0, retriesLeft: maxRetries })
    this.issue(req, 0)
  }

  /** A downstream attempt completed with any outcome (wire `lb.onDone` here). */
  observe(req: Request): void {
    const p = this.pending.get(req)
    if (!p) {
      // The client gave up on this attempt earlier; the server finished it
      // anyway. The outcome is real for the server, but nobody is watching.
      this.abandoned++
      return
    }
    p.timer?.cancel()
    this.pending.delete(req)
    const retryOn = this.opts.retryOn ?? ['error', 'timeout']
    if (retryOn.includes(req.outcome ?? 'error') && p.retriesLeft > 0) {
      p.retriesLeft--
      this.scheduleRetry(p)
      return
    }
    this.delivered++
    this.opts.onDone(req)
  }

  /** Client timeout: give up on the attempt, maybe re-send. */
  private onTimeout(p: Pending): void {
    this.pending.delete(p.req)
    this.timeouts++
    if (p.retriesLeft > 0) {
      p.retriesLeft--
      this.scheduleRetry(p)
      return
    }
    // Synthesize the final result at give-up time; the in-flight attempt keeps
    // its own Request object, which may still complete (and be swallowed).
    this.delivered++
    this.opts.onDone({ id: p.req.id, arrivedAt: p.req.arrivedAt, attempt: p.attempt, doneAt: this.sim.now, outcome: 'timeout' })
  }

  private scheduleRetry(p: Pending): void {
    const base = (this.opts.retryDelay ?? 0) * (this.opts.backoff ?? 1) ** p.attempt
    const j = this.opts.jitterFrac ?? 0
    const delay = j > 0 ? Math.max(0, base * (1 + j * (2 * this.opts.rng!.next() - 1))) : base
    this.sim.schedule(delay, () => this.retry(p))
  }

  private retry(p: Pending): void {
    p.attempt++
    const req: Request = { id: p.req.id, arrivedAt: p.req.arrivedAt, attempt: p.attempt }
    p.req = req
    this.pending.set(req, p)
    this.issue(req, p.attempt)
  }

  private issue(req: Request, attempt: number): void {
    req.attempt = attempt
    this.attempts++
    if (attempt > 0) this.retries++
    const p = this.pending.get(req)
    if (!p) throw new Error('Clients: issued an untracked attempt')
    // Arm the timeout BEFORE sending: the sink may complete synchronously (e.g.
    // an instant LB reject), and the client's clock starts at send time anyway.
    const t = this.opts.timeout
    if (t && t > 0) p.timer = this.sim.schedule(t, () => {
      if (this.pending.get(req)) this.onTimeout(p)
    })
    this.opts.sink(req)
  }
}
