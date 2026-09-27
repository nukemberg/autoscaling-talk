export type Outcome = 'ok' | 'rejected' | 'timeout' | 'error'

export interface Request {
  id: number
  arrivedAt: number
  startedAt?: number
  doneAt?: number
  outcome?: Outcome
  /** Retry attempt index (0 = first send). Retried requests keep the original
   *  `arrivedAt`, so a client-observed latency spans every attempt. */
  attempt?: number
}

/** Anything that accepts requests: load balancer, instance, upstream. */
export type Sink = (req: Request) => void
