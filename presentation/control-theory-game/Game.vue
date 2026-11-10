<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, shallowRef, triggerRef, watch } from 'vue'
import { BAND, clamp, randomOffset, randomTarget, Round, ROUND_SEC, Shower, START_TEMP, T_MAX, T_MIN, type RoundResult } from './model'

const RATE = 10 // °C per second while a direction is held
const TRACE_EVERY = 2 // record a trace point every N sim ticks

type Phase = 'ready' | 'running' | 'done'
interface TracePt { t: number; knob: number; water: number; target: number }

const delaySec = ref(3)
const startTarget = ref(randomTarget()) // where the round begins; restarts reuse it
const target = ref(startTarget.value)
const hits = ref(0)
const hold = ref(0) // 0..1 progress towards "stable"
const flash = ref(0) // bumps on every hit, retriggers the badge animation
let offset = randomOffset() // hidden: water = knob + offset
const phase = ref<Phase>('ready')
const knob = ref(START_TEMP)
const water = ref(START_TEMP)
const elapsed = ref(0)
const result = ref<RoundResult | null>(null)
const trace = shallowRef<TracePt[]>([])

let shower = new Shower({ delaySec: delaySec.value, offset })
let round = new Round(startTarget.value)
let tick = 0

function reset(newTarget: boolean): void {
  if (newTarget) {
    startTarget.value = randomTarget()
    offset = randomOffset()
  }
  shower = new Shower({ delaySec: delaySec.value, offset })
  round = new Round(startTarget.value)
  target.value = startTarget.value
  hits.value = 0
  hold.value = 0
  knob.value = shower.knob
  water.value = START_TEMP
  elapsed.value = 0
  result.value = null
  trace.value = []
  tick = 0
  phase.value = 'ready'
}

watch(delaySec, () => reset(false))

// --- input -----------------------------------------------------------------------------
const keys = new Set<string>()
const heldButton = ref(0) // -1 | 0 | 1 from the on-screen buttons
const UP = ['ArrowUp', 'ArrowRight', '+', '=', 'w', 'd']
const DOWN = ['ArrowDown', 'ArrowLeft', '-', '_', 's', 'a']

const dir = (): number => {
  let d = heldButton.value
  if (UP.some((k) => keys.has(k))) d += 1
  if (DOWN.some((k) => keys.has(k))) d -= 1
  return Math.max(-1, Math.min(1, d))
}

function onKeyDown(e: KeyboardEvent): void {
  if ((e.target as HTMLElement)?.tagName === 'INPUT') return
  if (e.key === ' ' || e.key === 'Enter') {
    e.preventDefault()
    reset(true)
    return
  }
  if ([...UP, ...DOWN].includes(e.key)) {
    e.preventDefault()
    keys.add(e.key)
  }
}
const onKeyUp = (e: KeyboardEvent): void => void keys.delete(e.key)

const knobTrack = ref<HTMLElement>()
let dragging = false
function dragTo(e: PointerEvent): void {
  const el = knobTrack.value
  if (!el || phase.value === 'done') return
  const r = el.getBoundingClientRect()
  const v = T_MIN + ((e.clientX - r.left) / r.width) * (T_MAX - T_MIN)
  shower.setKnob(v)
  knob.value = shower.knob
  if (phase.value === 'ready') phase.value = 'running'
}
function onTrackDown(e: PointerEvent): void {
  dragging = true
  ;(e.currentTarget as HTMLElement).setPointerCapture(e.pointerId)
  dragTo(e)
}
const onTrackMove = (e: PointerEvent): void => { if (dragging) dragTo(e) }
const onTrackUp = (): void => { dragging = false }

// --- loop ------------------------------------------------------------------------------
let raf = 0
let last = 0
let acc = 0

function frame(now: number): void {
  raf = requestAnimationFrame(frame)
  acc += Math.min(0.1, (now - last) / 1000)
  last = now
  const dt = shower.stepSec
  while (acc >= dt) {
    acc -= dt
    if (phase.value === 'done') continue
    const d = dir()
    if (d !== 0) {
      if (phase.value === 'ready') phase.value = 'running'
      shower.setKnob(shower.knob + d * RATE * dt)
    }
    if (phase.value !== 'running') continue
    shower.step()
    if (round.update(shower.water, dt)) flash.value++
    // The knob is plotted in water units ("what you asked for") so the delay is visible without printing the offset.
    if (tick++ % TRACE_EVERY === 0) trace.value.push({ t: round.elapsed, knob: shower.knob + offset, water: shower.water, target: round.target })
    if (round.done) {
      phase.value = 'done'
      result.value = round.result()
    }
  }
  knob.value = shower.knob
  water.value = shower.water
  elapsed.value = round.elapsed
  target.value = round.target
  hits.value = round.hits
  hold.value = round.holdFraction
  if (phase.value === 'running') triggerRef(trace)
}

onMounted(() => {
  window.addEventListener('keydown', onKeyDown)
  window.addEventListener('keyup', onKeyUp)
  last = performance.now()
  raf = requestAnimationFrame(frame)
})
onBeforeUnmount(() => {
  cancelAnimationFrame(raf)
  window.removeEventListener('keydown', onKeyDown)
  window.removeEventListener('keyup', onKeyUp)
})

// --- view helpers ----------------------------------------------------------------------
const pct = (v: number): number => ((clamp(v) - T_MIN) / (T_MAX - T_MIN)) * 100
const remaining = computed(() => Math.max(0, Math.ceil(ROUND_SEC - elapsed.value)))
const inBand = computed(() => Math.abs(water.value - target.value) <= BAND)
const scalding = computed(() => water.value > target.value + BAND * 3)
const freezing = computed(() => water.value < target.value - BAND * 3)

const TW = 600
const TH = 140
const tx = (t: number): number => (t / ROUND_SEC) * TW
const ty = (v: number): number => TH - (pct(v) / 100) * TH
const line = (key: 'knob' | 'water'): string => trace.value.map((p) => `${tx(p.t).toFixed(1)},${ty(p[key]).toFixed(1)}`).join(' ')

// Comfort band over time: upper edge left→right, then lower edge right→left.
const bandPoly = computed(() => {
  const pts = trace.value
  const up = pts.map((p) => `${tx(p.t).toFixed(1)},${ty(p.target + BAND).toFixed(1)}`)
  const dn = pts.map((p) => `${tx(p.t).toFixed(1)},${ty(p.target - BAND).toFixed(1)}`).reverse()
  return [...up, ...dn].join(' ')
})

const verdict = computed(() => {
  const r = result.value
  if (!r) return ''
  // Overshoot is the lesson, so it outranks a flattering time-in-band (the settled tail inflates that).
  if (r.hits === 0) return 'Never settled. Small moves, then wait for the water.'
  if (r.overshoot > BAND * 3 || r.lostBand >= 2) return 'You chased it. The water kept answering your old moves.'
  if (r.hits >= 3) return 'Smooth. You waited for the water.'
  return 'Not bad. Try making smaller moves, then waiting.'
})
</script>

<template>
  <main class="game">
    <header>
      <h1>Hot / Cold</h1>
      <p class="hint">Get the water into the green band and hold it there — the target moves once you do. Hold <kbd>↑</kbd> / <kbd>↓</kbd>, tap − / +, or drag the knob.</p>
    </header>

    <section class="bars" aria-label="Controls and water temperature">
      <div class="row">
        <span class="label">Knob</span>
        <div ref="knobTrack" class="track knob" @pointerdown="onTrackDown" @pointermove="onTrackMove" @pointerup="onTrackUp" @pointercancel="onTrackUp">
          <div class="fill" :style="{ width: pct(knob) + '%' }" />
          <div class="thumb" :style="{ left: pct(knob) + '%' }" />
        </div>
        <span class="val" />
      </div>

      <div class="row">
        <span class="label">Water</span>
        <div class="track water" :class="{ ok: inBand, hot: scalding, cold: freezing }">
          <div class="band" :style="{ left: pct(target - BAND) + '%', width: pct(T_MIN + BAND * 2) + '%' }" />
          <div class="target" :style="{ left: pct(target) + '%' }"><span>target {{ target }}°</span></div>
          <div class="needle" :style="{ left: pct(water) + '%' }" />
        </div>
        <span class="val" :class="{ hotText: scalding }">{{ water.toFixed(0) }}°</span>
      </div>
    </section>

    <svg class="trace" :viewBox="`0 0 ${TW} ${TH}`" preserveAspectRatio="none" aria-label="Your last moves and the water's response">
      <polygon v-if="trace.length" class="tband" :points="bandPoly" />
      <polyline class="tknob" :points="line('knob')" />
      <polyline class="twater" :points="line('water')" />
    </svg>
    <p class="legend"><i class="k" /> what you asked for <i class="w" /> the water</p>

    <section class="controls">
      <button class="big" aria-label="Colder" @pointerdown.prevent="heldButton = -1" @pointerup="heldButton = 0" @pointerleave="heldButton = 0" @pointercancel="heldButton = 0">−</button>
      <div class="timer" :class="{ idle: phase === 'ready' }">
        <template v-if="phase === 'ready'">Move the knob to start</template>
        <template v-else>
          {{ remaining }}s
          <small>hits {{ hits }}</small>
          <div class="hold" aria-label="Hold steady"><i :style="{ width: hold * 100 + '%' }" /></div>
        </template>
      </div>
      <button class="big" aria-label="Hotter" @pointerdown.prevent="heldButton = 1" @pointerup="heldButton = 0" @pointerleave="heldButton = 0" @pointercancel="heldButton = 0">+</button>
    </section>

    <section class="settings">
      <label>
        Lag <b>{{ delaySec }} s</b>
        <input v-model.number="delaySec" type="range" min="0" max="10" step="0.5">
      </label>
      <button class="ghost" @click="reset(true)">New round <kbd>Space</kbd></button>
    </section>

    <div v-if="flash && phase === 'running'" :key="flash" class="hit" aria-hidden="true">✓ hit</div>

    <div v-if="result" class="result" role="status">
      <div class="score">{{ result.hits }}<small> {{ result.hits === 1 ? 'target' : 'targets' }} held</small></div>
      <p>{{ verdict }}</p>
      <p class="stats">Lost the band {{ result.lostBand }}×<template v-if="result.overshoot > 0"> · worst overshoot {{ result.overshoot }}°</template></p>
      <p class="bridge">Your lag was <b>{{ delaySec }} s</b>. An autoscaler's is <b>minutes</b>.</p>
      <button class="ghost" @click="reset(true)">Play again <kbd>Space</kbd></button>
    </div>
  </main>
</template>

<style>
:root {
  --bg: #fff; --fg: #111; --muted: #6b7280; --card: #f4f4f5; --line: #d4d4d8;
  --amber: #d97706; --rose: #e11d48; --green: #059669; --blue: #2563eb;
  color-scheme: light dark;
}
@media (prefers-color-scheme: dark) {
  :root { --bg: #0b0b0d; --fg: #f4f4f5; --muted: #9ca3af; --card: #18181b; --line: #3f3f46; }
}
* { box-sizing: border-box; }
body { margin: 0; background: var(--bg); color: var(--fg); font-family: ui-rounded, 'Avenir Next', system-ui, sans-serif; -webkit-tap-highlight-color: transparent; }
</style>

<style scoped>
.game { max-width: 44rem; margin: 0 auto; padding: 1rem 1rem 2rem; position: relative; }
h1 { margin: 0; font-size: 2rem; font-weight: 900; }
.hint { margin: 0.25rem 0 1rem; color: var(--muted); }
kbd { font: inherit; font-size: 0.8em; padding: 0.05em 0.4em; border: 1px solid var(--line); border-bottom-width: 2px; border-radius: 0.3em; }

.row { display: grid; grid-template-columns: 3.5rem 1fr 3rem; align-items: center; gap: 0.75rem; margin: 0.9rem 0 2rem; }
.label { font-weight: 800; }
.val { font-weight: 800; font-variant-numeric: tabular-nums; text-align: right; }
.hotText { color: var(--rose); }

.track { position: relative; height: 2.2rem; border-radius: 1.1rem; background: var(--card); border: 2px solid var(--line); touch-action: none; }
.track.knob { cursor: ew-resize; }
.track .fill { position: absolute; inset: 0 auto 0 0; background: color-mix(in srgb, var(--amber) 35%, transparent); border-radius: inherit; pointer-events: none; }
.thumb { position: absolute; top: 50%; width: 1.6rem; height: 2.8rem; margin: -1.4rem 0 0 -0.8rem; border-radius: 0.6rem; background: var(--amber); box-shadow: 0 2px 6px #0004; pointer-events: none; }

.track.water { background: linear-gradient(90deg, #3b82f6, #a5b4fc 30%, #fcd34d 60%, #ef4444); border-color: var(--line); }
.track.water.ok { border-color: var(--green); box-shadow: 0 0 0 3px color-mix(in srgb, var(--green) 40%, transparent); }
.band { position: absolute; top: -2px; bottom: -2px; background: color-mix(in srgb, var(--green) 45%, transparent); border: 3px solid var(--green); border-radius: 0.5rem; }
.target { position: absolute; top: -0.4rem; bottom: -0.4rem; width: 0; border-left: 3px dashed var(--fg); }
.target span { position: absolute; top: 100%; left: 0; transform: translateX(-50%); margin-top: 0.3rem; white-space: nowrap; font-size: 0.8rem; font-weight: 800; }
.needle { position: absolute; top: -0.5rem; bottom: -0.5rem; width: 0.5rem; margin-left: -0.25rem; border-radius: 0.25rem; background: var(--fg); box-shadow: 0 0 0 2px var(--bg); transition: none; }
.track.water.hot .needle { background: var(--rose); }
.track.water.cold .needle { background: var(--blue); }

.trace { width: 100%; height: 8rem; display: block; background: var(--card); border: 2px solid var(--line); border-radius: 0.75rem; margin-top: 0.5rem; }
.tband { fill: color-mix(in srgb, var(--green) 28%, transparent); }
.tknob, .twater { fill: none; vector-effect: non-scaling-stroke; stroke-linejoin: round; }
.tknob { stroke: var(--amber); stroke-width: 3; stroke-dasharray: 6 5; }
.twater { stroke: var(--fg); stroke-width: 4; }
.legend { margin: 0.35rem 0 0; font-size: 0.85rem; color: var(--muted); }
.legend i { display: inline-block; width: 1.4rem; height: 0; margin: 0 0.3rem 0 0.8rem; vertical-align: middle; border-top: 3px solid; }
.legend .k { border-color: var(--amber); border-top-style: dashed; }
.legend .w { border-color: var(--fg); border-top-width: 4px; }

.controls { display: grid; grid-template-columns: 5rem 1fr 5rem; align-items: center; gap: 0.75rem; margin: 1rem 0; }
.big { height: 4.5rem; font-size: 2.4rem; font-weight: 900; border-radius: 1rem; border: 2px solid var(--line); background: var(--card); color: var(--fg); touch-action: none; user-select: none; }
.big:active { background: color-mix(in srgb, var(--amber) 30%, var(--card)); }
.timer { text-align: center; font-size: 2rem; font-weight: 900; font-variant-numeric: tabular-nums; }
.timer.idle { font-size: 1.05rem; font-weight: 700; color: var(--muted); }
.timer small { display: block; font-size: 0.9rem; font-weight: 700; color: var(--muted); }
.hold { height: 0.45rem; margin: 0.3rem auto 0; max-width: 8rem; border-radius: 0.25rem; background: var(--card); border: 1px solid var(--line); overflow: hidden; }
.hold i { display: block; height: 100%; background: var(--green); }
.hit { position: absolute; right: 1rem; top: 7.2rem; font-weight: 900; font-size: 1.3rem; color: var(--green); animation: hit 0.9s ease-out forwards; pointer-events: none; }
@keyframes hit { from { opacity: 1; transform: translateY(0); } to { opacity: 0; transform: translateY(-14px); } }

.settings { display: flex; align-items: end; justify-content: space-between; gap: 1rem; flex-wrap: wrap; }
.settings label { display: grid; gap: 0.3rem; font-weight: 700; flex: 1 1 14rem; }
.settings input[type='range'] { width: 100%; accent-color: var(--amber); }
.ghost { padding: 0.6rem 1rem; border-radius: 0.75rem; border: 2px solid var(--line); background: transparent; color: var(--fg); font: inherit; font-weight: 700; cursor: pointer; }

.result { position: absolute; inset: 0; display: flex; flex-direction: column; justify-content: center; gap: 0.4rem; padding: 1.5rem; margin: 0.5rem; background: color-mix(in srgb, var(--bg) 92%, transparent); backdrop-filter: blur(4px); border: 3px solid var(--amber); border-radius: 1.25rem; text-align: center; }
.score { font-size: 4rem; font-weight: 900; line-height: 1; }
.score small { font-size: 1.1rem; font-weight: 700; color: var(--muted); }
.result p { margin: 0.2rem 0; font-size: 1.2rem; font-weight: 700; }
.result .stats { color: var(--muted); font-weight: 600; font-size: 1rem; }
.result .bridge { margin-top: 0.8rem; font-size: 1.3rem; }
.result .bridge b { color: var(--rose); }
.result .ghost { align-self: center; margin-top: 0.8rem; }
</style>
