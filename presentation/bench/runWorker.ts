/** Sim-run worker: executes scenario runs off the main thread, streaming progress. */

import { scenario } from '../sim/scenarios/registry'
import type { Params, ScenarioResult } from '../sim/scenarios/types'

export interface RunRequest {
  id: number
  scenarioId: string
  params: Params
}

export type RunResponse =
  | { type: 'progress'; id: number; fraction: number }
  | { type: 'done'; id: number; result: ScenarioResult; runMs: number }
  | { type: 'error'; id: number; message: string }

// SAFETY: inside a dedicated module worker `self` is a DedicatedWorkerGlobalScope,
// whose only member we use is postMessage; TS's inferred lib here is DOM-window
// (no webworker lib in the project), so the runtime-correct narrower shape is
// asserted manually.
const ctx = self as unknown as { postMessage(msg: RunResponse): void }

function handleMessage(e: MessageEvent<RunRequest>) {
  if (!e.data || typeof e.data !== 'object') return
  const { id, scenarioId, params } = e.data
  try {
    const def = scenario(scenarioId)
    const progress = (fraction: number) =>
      ctx.postMessage({ type: 'progress', id, fraction } satisfies RunResponse)
    const t0 = performance.now()
    const result = def.run(params, progress)
    ctx.postMessage({ type: 'done', id, result, runMs: performance.now() - t0 } satisfies RunResponse)
  } catch (err) {
    ctx.postMessage({ type: 'error', id, message: (err as Error).message } satisfies RunResponse)
  }
}

self.addEventListener('message', handleMessage as EventListener)
self.onmessage = handleMessage