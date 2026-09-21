export type Outcome = 'ok' | 'rejected' | 'timeout' | 'error'

export interface Request {
  id: number
  arrivedAt: number
  startedAt?: number
  doneAt?: number
  outcome?: Outcome
}

/** Anything that accepts requests: load balancer, instance, upstream. */
export type Sink = (req: Request) => void
