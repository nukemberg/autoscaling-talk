import { describe, expect, test } from 'vitest'
import { cpuModel } from './cpu'
import { resolvePreset, toPreset } from './preset'
import { defaults } from './types'

describe('presets', () => {
  test('resolvePreset fills defaults and applies overrides last', () => {
    const { def, params } = resolvePreset({ model: 'cpu-step', params: { rps: 900 } }, { ramp: 'linear' })
    expect(def).toBe(cpuModel)
    expect(params.rps).toBe(900)
    expect(params.ramp).toBe('linear')
    expect(params.hpaSyncSec).toBe(15)
  })

  test('resolvePreset rejects unknown params', () => {
    expect(() => resolvePreset({ model: 'cpu-step', params: { nope: 1 } })).toThrow(/no param "nope"/)
  })

  test('toPreset keeps only non-default values; round-trips', () => {
    const full = { ...defaults(cpuModel.params), rps: 900, awsDisableScaleIn: true }
    const preset = toPreset(cpuModel, full)
    expect(preset).toEqual({ model: 'cpu-step', params: { rps: 900, awsDisableScaleIn: true } })
    expect(resolvePreset(preset).params).toEqual(full)
  })

  test('toPreset includes name/notes only when given', () => {
    const full = defaults(cpuModel.params)
    expect(toPreset(cpuModel, full)).toEqual({ model: 'cpu-step', params: {} })
    expect(toPreset(cpuModel, full, 'my preset')).toEqual({ model: 'cpu-step', params: {}, name: 'my preset' })
    expect(toPreset(cpuModel, full, undefined, 'explains itself'))
      .toEqual({ model: 'cpu-step', params: {}, notes: 'explains itself' })
    expect(toPreset(cpuModel, full, 'n', 'notes'))
      .toEqual({ model: 'cpu-step', params: {}, name: 'n', notes: 'notes' })
  })
})
