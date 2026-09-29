import { Arrivals, step } from '../arrivals'
import { Clients } from '../clients'
import { Cluster } from '../cluster'
import { Cost } from '../cost'
import { Sim } from '../engine'
import { LoadBalancer } from '../lb'
import { Recorder, Tally } from '../metrics'
import { Rng } from '../rng'
import { injectFaults } from '../faults'
import { Stats } from '../stats'
import {
  attachController, clientParams, clusterOpts, costOpts, costParams, faultParams, faults, instanceOpts, lbOpts,
  loadParams, loadProfile, neededInstances, scalerParams, serverParams,
} from './shared'
import { bool, num, type ParamSpec, type Params, type SimModel } from './types'

const simParams: ParamSpec[] = [
  { key: 'horizonSec', label: 'horizon', group: 'sim', kind: 'range', min: 300, max: 7200, step: 60, default: 2100, unit: 's',
    help: 'Simulated duration.' },
  { key: 'sampleSec', label: 'sample', group: 'sim', kind: 'range', min: 1, max: 60, step: 1, default: 5, unit: 's',
    help: 'Chart resolution: one point per this many seconds.' },
  { key: 'seed', label: 'seed', group: 'sim', kind: 'range', min: 1, max: 100, step: 1, default: 1,
    help: 'Random seed. Same seed → identical run.' },
]

/** One cluster, stateless instances, autoscaled on busy fraction ("CPU"). */
export const cpuModel: SimModel = {
  id: 'cpu-step',
  title: 'CPU autoscaling under a load step',
  description: 'Stable base load, then a ramp. Autoscaler acts on mean busy fraction across ready instances.',
  params: [...loadParams, ...clientParams, ...serverParams, ...scalerParams, ...faultParams, ...costParams, ...simParams],
  charts: [
    {
      yLabel: 'instances',
      series: [
        { key: 'instances', label: 'instances', color: 'inst', width: 2 },
        { key: 'ready', label: 'ready', color: 'muted', width: 1, dash: [4, 4] },
        { key: 'inRotation', label: 'in LB rotation', color: 'accent', width: 1, dash: [2, 3] },
        { key: 'metric', label: 'scaling metric', color: 'cpu', width: 1.5, scale: 'pct' },
      ],
      scales: { pct: { range: [0, 100], label: 'scaling metric', color: 'cpu' } },
    },
    {
      yLabel: 'req/s',
      series: [
        { key: 'offeredRps', label: 'incoming', color: 'accent', width: 1.5 },
        { key: 'okRps', label: 'OK', color: 'ok', width: 2 },
        { key: 'usefulRps', label: 'useful (excl. external actor)', color: 'accent', width: 1.5, dash: [4, 4] },
        { key: 'failedRps', label: 'errors', color: 'cpu', width: 2 },
        { key: 'retriedRps', label: 'client retries', color: 'latency', width: 1.5, dash: [2, 3] },
      ],
    },
    {
      yLabel: 'ms',
      series: [
        { key: 'latencyMs', label: 'latency (mean, OK requests)', color: 'latency', width: 2 },
        { key: 'p95Ms', label: 'latency (p95, OK requests)', color: 'cpu', width: 1.5, dash: [4, 4] },
      ],
    },
    {
      yLabel: 'cumulative $',
      series: [
        { key: 'instanceCost', label: 'instance cost', color: 'inst', width: 2 },
        { key: 'extraCost', label: 'extra upstream cost', color: 'cpu', width: 1.5, dash: [4, 4] },
      ],
    },
  ],

  run(p: Params, progress?: (fraction: number) => void) {
    const bootSec = num(p, 'bootSec'), quietSec = num(p, 'quietSec')
    const horizon = num(p, 'horizonSec'), sample = num(p, 'sampleSec')
    // Total simulated span: warmup + horizon. `t0` below equals the warmup end
    // (run() ends the clock exactly at `until`), so this is the run's full extent.
    const warmupEnd = bootSec + num(p, 'healthCheckSec') * (num(p, 'healthyAfter') + 1)
    const end = warmupEnd + horizon

    const sim = new Sim()
    const rng = new Rng(num(p, 'seed'))
    // The latency metric (see metricRegistry.latencyMetric) needs the windowed request log;
    // every other metric only reads `totals`, so skip the log's allocation unless it's in use.
    const stats = new Stats(sim, { track: bool(p, 'metricLatency') })
    const latencyTally = new Tally() // OK-request latencies for the current sample window, reset each tick
    const lb = new LoadBalancer(sim, lbOpts(p))
    // External clients sit between the load source and the LB: per-attempt
    // timeout + retries. Failed attempts are NOT recorded by Stats — a request
    // is recorded once, with its client-observed (end-to-end) outcome.
    let scraperOk = 0
    const clients = new Clients(sim, {
      sink: (r) => lb.handle(r),
      onDone: (r) => {
        stats.record(r)
        if (r.outcome === 'ok') {
          latencyTally.add(((r.doneAt ?? sim.now) - r.arrivedAt) * 1000)
          if (r.source === 'scraper') scraperOk++
        }
      },
      timeout: num(p, 'clientTimeoutSec') || undefined,
      maxRetries: num(p, 'clientMaxRetries'),
      retryDelay: num(p, 'clientRetryDelaySec'),
      backoff: num(p, 'clientBackoffFactor'),
      jitterFrac: num(p, 'clientRetryJitterPct') / 100,
      rng,
    })
    lb.onDone = (r) => clients.observe(r)
    const cluster = new Cluster(sim, lb, instanceOpts(p, rng), clusterOpts(p))
    const cost = new Cost(sim, { cluster, ...costOpts(p, cluster) })
    cost.start()
    if (progress) sim.onProgress = (now) => progress(Math.min(1, now / end))

    // Start already sized for the base load, warm — the steady state before anything happens.
    // (0 = auto: size for base load; explicit `initialInstances` overrides that, still clamped to [min, max].)
    const initial = num(p, 'initialInstances')
    const needed = initial > 0 ? initial : Math.ceil(neededInstances(p, num(p, 'baseRps')))
    cluster.scaleTo(Math.min(num(p, 'maxInstances'), Math.max(num(p, 'minInstances'), needed)))
    sim.run(warmupEnd)
    const t0 = sim.now

    const offered = loadProfile(p, t0 + quietSec, rng)
    new Arrivals(sim, rng, offered, (r) => clients.handle(r)).start()
    const scraperRps = num(p, 'scraperRps')
    if (scraperRps > 0) {
      const scraperRate = step(t0 + num(p, 'scraperStartSec'), 0, scraperRps)
      new Arrivals(sim, rng, scraperRate, (r) => { r.source = 'scraper'; clients.handle(r) }).start()
    }
    const controller = attachController(sim, cluster, p, stats)
    const faultList = faults(p, t0)
    injectFaults(sim, { cluster, pools: cluster.pools }, faultList)

    let lastTotals = { ...stats.totals }
    let lastRetries = clients.retries
    let lastScraperOk = scraperOk
    const delta = (k: keyof typeof stats.totals) => stats.totals[k] - lastTotals[k]
    const rec = new Recorder(sim, sample, {
      instances: () => cluster.size,
      ready: () => cluster.ready,
      inRotation: () => lb.readyCount,
      metric: () => controller.metricKind === 'utilization' ? controller.metric * 100 : controller.metric,
      offeredRps: () => offered(sim.now),
      okRps: () => delta('ok') / sample,
      usefulRps: () => (delta('ok') - (scraperOk - lastScraperOk)) / sample,
      failedRps: () => (delta('rejected') + delta('error') + delta('timeout')) / sample,
      retriedRps: () => (clients.retries - lastRetries) / sample,
      latencyMs: () => latencyTally.count ? latencyTally.mean : 0,
      p95Ms: () => latencyTally.count ? latencyTally.percentile(0.95) : 0,
      instanceCost: () => cost.instanceCost,
      extraCost: () => cost.extraCost,
      // Probes run in order; this last one resets the per-window baselines.
      _tick: () => { lastTotals = { ...stats.totals }; lastRetries = clients.retries; lastScraperOk = scraperOk; latencyTally.reset(); return 0 },
    })
    rec.start()
    sim.run(t0 + horizon)

    const { _tick, ...series } = rec.series
    const ok = series.okRps.reduce((a, b) => a + b, 0), failed = series.failedRps.reduce((a, b) => a + b, 0)
    return {
      t: rec.t.map((t) => t - t0),
      series,
      metricKind: controller.metricKind,
      markers: [
        { t: quietSec, label: 'load starts →' },
        ...faultList.map((f) => ({ t: f.at - t0, label: `${f.kind} →` })),
      ],
      summary: {
        needed: neededInstances(p, num(p, 'rps')).toFixed(1),
        peak: Math.max(...series.instances),
        final: series.instances[series.instances.length - 1],
        'errors %': ok + failed ? (100 * failed / (ok + failed)).toFixed(1) : '0',
        'client retries': clients.retries,
        'client timeouts': clients.timeouts,
        'external actor requests': scraperOk,
        'total cost': `$${cost.total.toFixed(2)}`,
      },
    }
  },
}
