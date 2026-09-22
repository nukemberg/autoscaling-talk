// Event-count instrumentation — bundled by vite, run with plain node.
import { Sim } from '../sim/engine'
import { cpuScenario } from '../sim/scenarios/cpu'
import { defaults } from '../sim/scenarios/types'

const p = defaults(cpuScenario.params)
// Exact workbench URL params (cpu-oscillation preset)
p.baseRps = 300
p.rps = 1360
p.ramp = 'step'
p.bootSec = 240
p.algo = 'aws-simple'
p.awsPeriodSec = 15
p.awsMetricDelaySec = 0
p.awsOutThreshold = 0.55
p.awsOutPeriods = 1
p.awsInThreshold = 0.45
p.awsInPeriods = 1
p.awsCooldownSec = 0
p.maxInstances = 50
p.horizonSec = 3000
p.sampleSec = 10

let scheduled = 0
let cancelled = 0
const origSchedule = Sim.prototype.scheduleAt
Sim.prototype.scheduleAt = function (this: Sim, t: number, fn: () => void) {
  scheduled++
  const h = origSchedule.call(this, t, fn)
  const origCancel = h.cancel.bind(h)
  h.cancel = () => { cancelled++; origCancel() }
  return h
}

const t0 = performance.now()
const r = cpuScenario.run(p)
const ms = performance.now() - t0
console.log(`run: ${ms.toFixed(0)} ms, scheduled events: ${scheduled}, cancelled: ${cancelled}, peak=${r.summary.peak}`)
