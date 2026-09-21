import { cpuScenario } from './cpu'
import type { ScenarioDef } from './types'

export const scenarios: ScenarioDef[] = [cpuScenario]

export function scenario(id: string): ScenarioDef {
  const s = scenarios.find((s) => s.id === id)
  if (!s) throw new Error(`unknown scenario: ${id}`)
  return s
}
