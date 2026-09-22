import { scenario } from './registry'
import { defaults, type Params, type ScenarioDef } from './types'

/** What the workbench exports and the slides load. Only non-default params need to be listed. */
export interface Preset {
  id: string
  params: Params
  /** Display name; also the export filename. */
  name?: string
  /** Freeform explanation: what this preset shows and why it looks the way it does. */
  notes?: string
}

/** Resolve a preset to its scenario plus a full parameter set. */
export function resolvePreset(preset: Preset, overrides: Params = {}): { def: ScenarioDef; params: Params } {
  const def = scenario(preset.id)
  const known = new Set(def.params.map((p) => p.key))
  for (const k of [...Object.keys(preset.params), ...Object.keys(overrides)]) {
    if (!known.has(k)) throw new Error(`scenario ${preset.id} has no param "${k}"`)
  }
  return { def, params: { ...defaults(def.params), ...preset.params, ...overrides } }
}

/** Trim a full parameter set down to what differs from defaults — for export. */
export function toPreset(def: ScenarioDef, params: Params, name?: string, notes?: string): Preset {
  const base = defaults(def.params)
  const out: Params = {}
  for (const [k, v] of Object.entries(params)) if (base[k] !== v) out[k] = v
  return {
    id: def.id,
    params: out,
    ...(name ? { name } : {}),
    ...(notes ? { notes } : {}),
  }
}
