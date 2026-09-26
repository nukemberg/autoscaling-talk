import { cpuModel } from './cpu'
import type { SimModel } from './types'

export const models: SimModel[] = [cpuModel]

export function model(id: string): SimModel {
  const m = models.find((m) => m.id === id)
  if (!m) throw new Error(`unknown model: ${id}`)
  return m
}
