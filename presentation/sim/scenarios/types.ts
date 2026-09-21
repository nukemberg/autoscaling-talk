/** Declarative description of a scenario: params, how to run, how to chart. */

export type ParamGroup = 'load' | 'unit' | 'scaler' | 'upstream' | 'fault' | 'sim'

interface Common {
  key: string
  label: string
  group: ParamGroup
  /** Tooltip. Required: every control explains itself. */
  help: string
  /** Greyed out unless these other params have one of the listed values. */
  activeWhen?: Record<string, string | string[]>
}

export type ParamSpec =
  | (Common & { kind: 'range'; min: number; max: number; step: number; default: number; unit?: string })
  | (Common & { kind: 'select'; options: { value: string; label: string }[]; default: string })
  | (Common & { kind: 'toggle'; default: boolean })

export function isActive(spec: ParamSpec, params: Params): boolean {
  if (!spec.activeWhen) return true
  return Object.entries(spec.activeWhen).every(([k, v]) => (Array.isArray(v) ? v : [v]).includes(String(params[k])))
}

export type Params = Record<string, number | string | boolean>

export interface Marker { t: number; label: string }

export interface ScenarioResult {
  t: number[]
  series: Record<string, number[]>
  markers: Marker[]
  summary: Record<string, string | number>
}

export interface SeriesSpec {
  key: string
  label: string
  color: string
  width?: number
  dash?: number[]
  /** Secondary y-scale name (e.g. 'pct'); default = primary. */
  scale?: string
}

export interface ChartSpec {
  title?: string
  yLabel: string
  series: SeriesSpec[]
  /** Extra scales, e.g. { pct: [0, 100] }. */
  scales?: Record<string, { range: [number, number]; label: string; color?: string }>
  height?: number
}

export interface ScenarioDef {
  id: string
  title: string
  description: string
  params: ParamSpec[]
  charts: ChartSpec[]
  run(params: Params): ScenarioResult
}

export function defaults(specs: ParamSpec[]): Params {
  const out: Params = {}
  for (const s of specs) out[s.key] = s.default
  return out
}

export function num(p: Params, key: string): number {
  const v = p[key]
  if (typeof v !== 'number') throw new TypeError(`param ${key} is not a number: ${v}`)
  return v
}

export function str(p: Params, key: string): string {
  const v = p[key]
  if (typeof v !== 'string') throw new TypeError(`param ${key} is not a string: ${v}`)
  return v
}

export function bool(p: Params, key: string): boolean {
  const v = p[key]
  if (typeof v !== 'boolean') throw new TypeError(`param ${key} is not a boolean: ${v}`)
  return v
}
