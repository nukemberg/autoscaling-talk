import type { Sim } from './engine'
import { Instance, type InstanceOpts } from './instance'
import type { LoadBalancer } from './lb'
import { TimeWeighted } from './metrics'

export interface ClusterOpts {
  /** Like an ASG health check: relaunch a crashed instance after this delay. */
  replaceDeadAfter?: number
}

/** The set of scaling units behind one LB. Launches and terminates instances. */
export class Cluster {
  launched = 0
  terminated = 0
  private pool: Instance[] = []
  private desired = 0
  private sizeOverTime: TimeWeighted

  constructor(
    private sim: Sim,
    private lb: LoadBalancer,
    private instanceOpts: InstanceOpts,
    private opts: ClusterOpts = {},
  ) {
    this.sizeOverTime = new TimeWeighted(sim, 0)
  }

  get instances(): readonly Instance[] { return this.pool }
  get size(): number { return this.pool.length }
  /** ∫ size dt — what the bill is based on. Booting instances count. */
  get instanceTime(): number { return this.sizeOverTime.mean * this.sim.now }

  get ready(): number { return this.pool.filter((i) => i.state === 'ready').length }

  /** Mean utilization across ready instances — the "cluster CPU" an autoscaler sees. */
  get utilization(): number {
    const ready = this.pool.filter((i) => i.state === 'ready')
    if (!ready.length) return 0
    return ready.reduce((s, i) => s + i.utilization, 0) / ready.length
  }

  /** Mean *reported* cpu across ready instances — includes whatever hung instances claim. */
  get cpu(): number {
    const ready = this.pool.filter((i) => i.state === 'ready')
    if (!ready.length) return 0
    return ready.reduce((s, i) => s + i.cpu, 0) / ready.length
  }

  scaleTo(n: number): void {
    this.desired = n
    while (this.pool.length < n) this.launch()
    while (this.pool.length > n) this.kill()
  }

  /** An instance dies (fault). Its requests fail; a replacement may follow unless `replace` is false. */
  crash(inst: Instance, replace = true): void {
    if (!this.pool.includes(inst)) return
    this.pool = this.pool.filter((i) => i !== inst)
    this.lb.remove(inst)
    inst.terminate()
    this.terminated++
    this.sizeOverTime.set(this.pool.length)
    const delay = this.opts.replaceDeadAfter
    if (replace && delay !== undefined) {
      this.sim.schedule(delay, () => { if (this.pool.length < this.desired) this.launch() })
    }
  }

  private launch(): void {
    const inst = new Instance(this.sim, this.instanceOpts)
    this.pool.push(inst)
    this.lb.add(inst)
    this.launched++
    this.sizeOverTime.set(this.pool.length)
  }

  /** Youngest first: booting instances die before they ever serve. */
  private kill(): void {
    const inst = this.pool.pop()!
    this.lb.remove(inst)
    inst.terminate()
    this.terminated++
    this.sizeOverTime.set(this.pool.length)
  }
}
