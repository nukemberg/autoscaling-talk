import { Arrivals } from '../arrivals'
import { Cluster } from '../cluster'
import { Sim } from '../engine'
import { LoadBalancer } from '../lb'
import { Recorder } from '../metrics'
import { Rng } from '../rng'
import { Stats } from '../stats'
import { attachScaler, loadParams, loadProfile, neededInstances, scalerParams, unitParams } from './shared'
import { num, type ParamSpec, type Params, type ScenarioDef } from './types'

const simParams: ParamSpec[] = [
  { key: 'horizonSec', label: 'horizon', group: 'sim', kind: 'range', min: 300, max: 7200, step: 60, default: 2100, unit: 's' },
  { key: 'sampleSec', label: 'sample', group: 'sim', kind: 'range', min: 1, max: 60, step: 1, default: 5, unit: 's' },
  { key: 'seed', label: 'seed', group: 'sim', kind: 'range', min: 1, max: 100, step: 1, default: 1 },
]

/** One cluster, stateless instances, autoscaled on busy fraction ("CPU"). */
export const cpuScenario: ScenarioDef = {
  id: 'cpu-step',
  title: 'CPU autoscaling under a load step',
  description: 'Stable base load, then a ramp. Autoscaler acts on mean busy fraction across ready instances.',
  params: [...loadParams, ...unitParams, ...scalerParams, ...simParams],
  charts: [
    {
      yLabel: 'instances',
      series: [
        { key: 'instances', label: 'instances', color: 'black', width: 2 },
        { key: 'ready', label: 'ready', color: '#888', width: 1, dash: [4, 4] },
        { key: 'cpu', label: 'cpu %', color: '#c0392b', width: 1.5, scale: 'pct' },
      ],
      scales: { pct: { range: [0, 100], label: 'cpu %', color: '#c0392b' } },
    },
    {
      yLabel: 'req/s',
      series: [
        { key: 'offeredRps', label: 'incoming', color: '#888', width: 1, dash: [4, 4] },
        { key: 'okRps', label: 'OK', color: '#27ae60', width: 2 },
        { key: 'failedRps', label: 'errors', color: '#c0392b', width: 2 },
      ],
    },
  ],

  run(p: Params) {
    const bootSec = num(p, 'bootSec'), quietSec = num(p, 'quietSec')
    const horizon = num(p, 'horizonSec'), sample = num(p, 'sampleSec')

    const sim = new Sim()
    const rng = new Rng(num(p, 'seed'))
    const stats = new Stats(sim)
    const lb = new LoadBalancer(sim)
    lb.onDone = (r) => stats.record(r)

    const cluster = new Cluster(sim, lb, {
      bootTime: bootSec,
      serviceTime: () => rng.exp(1000 / num(p, 'latencyMs')),
      concurrency: num(p, 'concurrency'),
      queueLimit: 0,
    })

    // Start already sized for the base load, warm — the steady state before anything happens.
    const needed = Math.ceil(neededInstances(p, num(p, 'baseRps')))
    cluster.scaleTo(Math.min(num(p, 'maxInstances'), Math.max(num(p, 'minInstances'), needed)))
    sim.run(bootSec)
    const t0 = sim.now

    const offered = loadProfile(p, t0 + quietSec)
    new Arrivals(sim, rng, offered, (r) => lb.handle(r)).start()
    attachScaler(sim, cluster, () => cluster.utilization, p)

    let lastTotals = { ...stats.totals }
    const delta = (k: keyof typeof stats.totals) => stats.totals[k] - lastTotals[k]
    const rec = new Recorder(sim, sample, {
      instances: () => cluster.size,
      ready: () => cluster.ready,
      cpu: () => cluster.utilization * 100,
      offeredRps: () => offered(sim.now),
      okRps: () => delta('ok') / sample,
      failedRps: () => (delta('rejected') + delta('error') + delta('timeout')) / sample,
      // Probes run in order; this last one resets the per-window baseline.
      _tick: () => { lastTotals = { ...stats.totals }; return 0 },
    })
    rec.start()
    sim.run(t0 + horizon)

    const { _tick, ...series } = rec.series
    const ok = series.okRps.reduce((a, b) => a + b, 0), failed = series.failedRps.reduce((a, b) => a + b, 0)
    return {
      t: rec.t.map((t) => t - t0),
      series,
      markers: [{ t: quietSec, label: 'load starts →' }],
      summary: {
        needed: neededInstances(p, num(p, 'rps')).toFixed(1),
        peak: Math.max(...series.instances),
        final: series.instances[series.instances.length - 1],
        'errors %': ok + failed ? (100 * failed / (ok + failed)).toFixed(1) : '0',
      },
    }
  },
}
