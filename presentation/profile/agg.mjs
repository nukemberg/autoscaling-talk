// Aggregate self-time from a V8 .cpuprofile
import { readFileSync } from 'node:fs'

let prof
try {
  prof = JSON.parse(readFileSync(process.argv[2], 'utf8'))
} catch (e) {
  console.error(`bad profile: ${e.message}`)
  process.exit(1)
}
const { nodes, samples, timeDeltas } = prof
const byId = new Map(nodes.map((n) => [n.id, n]))
const self = new Map() // nodeId -> µs
let total = 0
for (let i = 0; i < samples.length; i++) {
  const d = timeDeltas[i] ?? 0
  self.set(samples[i], (self.get(samples[i]) ?? 0) + d)
  total += d
}

// Roll up by (functionName + url:line)
const agg = new Map()
for (const [id, us] of self) {
  const n = byId.get(id)
  if (!n) continue
  const cf = n.callFrame
  const key = `${cf.functionName || '(anon)'} @ ${cf.url.replace(/^.*\//, '')}:${cf.lineNumber + 1}`
  agg.set(key, (agg.get(key) ?? 0) + us)
}
const rows = [...agg].sort((a, b) => b[1] - a[1]).slice(0, 30)
for (const [k, us] of rows) console.log(`${(us / 1000).toFixed(0).padStart(7)} ms  ${(100 * us / total).toFixed(1).padStart(5)}%  ${k}`)
console.log(`total ${(total / 1000).toFixed(0)} ms`)
