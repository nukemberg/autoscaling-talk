import { describe, expect, test } from 'vitest'
import { cpuScenario } from './cpu'
import { resolvePreset, toPreset } from './preset'
import { defaults } from './types'

describe('presets', () => {
  test('resolvePreset fills defaults and applies overrides last', () => {
    const { def, params } = resolvePreset({ id: 'cpu-step', params: { rps: 900 } }, { ramp: 'linear' })
    expect(def).toBe(cpuScenario)
    expect(params.rps).toBe(900)
    expect(params.ramp).toBe('linear')
    expect(params.periodSec).toBe(30)
  })

  test('resolvePreset rejects unknown params', () => {
    expect(() => resolvePreset({ id: 'cpu-step', params: { nope: 1 } })).toThrow(/no param "nope"/)
  })

  test('toPreset keeps only non-default values; round-trips', () => {
    const full = { ...defaults(cpuScenario.params), rps: 900, countInFlight: true }
    const preset = toPreset(cpuScenario, full)
    expect(preset).toEqual({ id: 'cpu-step', params: { rps: 900, countInFlight: true } })
    expect(resolvePreset(preset).params).toEqual(full)
  })
})
