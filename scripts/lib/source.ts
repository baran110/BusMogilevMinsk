import type { SourceCoverage, SourceHealth, Trip } from '../../src/types'

export interface SourceResult {
  trips: Trip[]
  health: SourceHealth
  /** No more requests in this cycle after a block, cancellation or open circuit. */
  halted?: boolean
  /** Complete last successful enumerations, including empty dates, carried by staged sources. */
  confirmedCoverage?: SourceCoverage[]
}

export function errorResult(id: string, name: string, kind: 'carrier' | 'platform', url: string, error: unknown, now = new Date()): SourceResult {
  return {
    trips: [],
    health: {
      id,
      name,
      kind,
      url,
      status: 'error',
      checkedAt: now.toISOString(),
      message: error instanceof Error ? error.message.slice(0, 180) : 'Неизвестная ошибка',
    },
  }
}
