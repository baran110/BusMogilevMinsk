import type { SourceHealth, Trip } from '../../src/types'

export interface SourceResult {
  trips: Trip[]
  health: SourceHealth
}

export function errorResult(id: string, name: string, kind: 'carrier' | 'platform', url: string, error: unknown): SourceResult {
  return {
    trips: [],
    health: {
      id,
      name,
      kind,
      url,
      status: 'error',
      checkedAt: new Date().toISOString(),
      message: error instanceof Error ? error.message.slice(0, 180) : 'Неизвестная ошибка',
    },
  }
}
