// Profiling harness — bundled by vite, run under `node --cpu-prof`.
import { cpuScenario } from '../sim/scenarios/cpu'
import { defaults } from '../sim/scenarios/types'
import type { Params } from '../sim/scenarios/types'

function timeRun(p: Params, label: string): void {
  const t0 = performance.now()
  const r = cpuScenario.run(p)
  const ms = performance.now() - t0
  const n = r.series.okRps.length
  console.log(`${label}: ${ms.toFixed(0)} ms (${(ms * 1000 / n).toFixed(0)} µs/sample), peak=${r.summary.peak}`)
}

// The preset that was live in the workbench tab (aws-simple, slow boot, 1360 rps).
const p1 = defaults(cpuScenario.params)
p1.baseRps = 300
p1.rps = 1360
p1.ramp = 'step'
p1.bootSec = 240
p1.algo = 'aws-simple'
p1.awsPeriodSec = 15
p1.maxInstances = 50
p1.horizonSec = 3000
p1.sampleSec = 10
p1.latencyMs = 100
p1.concurrency = 16

// A heavier, HPA-flavored run: higher load, longer horizon, finer sampling.
const p2 = defaults(cpuScenario.params)
p2.baseRps = 300
p2.rps = 4000
p2.ramp = 'logistic'
p2.rampSec = 300
p2.bootSec = 120
p2.algo = 'hpa'
p2.maxInstances = 200
p2.horizonSec = 3600
p2.sampleSec = 5
p2.latencyMs = 100
p2.concurrency = 16

// warmup (JIT)
timeRun({ ...p1, horizonSec: 300 }, 'warmup')
timeRun(p1, 'aws-simple 1360rps')
timeRun(p1, 'aws-simple 1360rps (2)')
timeRun(p2, 'hpa 4000rps')
timeRun(p2, 'hpa 4000rps (2)')
