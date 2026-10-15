import { addDays, localDate } from '../../src/lib/date'
import type { Direction, SourceCoverage, SourceHealth, Trip } from '../../src/types'
import { sourceSignal, mapConcurrent } from './runtime'
import type { SourceResult } from './source'
import { HttpError } from './fetch'

export function requestedPairs(days: number): Array<{ direction: Direction; date: string }> {
  const today = localDate()
  return Array.from({ length: days }, (_, day) => (['mogilev-minsk', 'minsk-mogilev'] as const).map((direction) => ({ direction, date: addDays(today, day) }))).flat()
}

export function completeFailedCoverage(result: SourceResult, pairs: Array<{ direction: Direction; date: string }>): SourceResult {
  if (result.health.status !== 'error' && result.health.status !== 'stale') return result
  const coverage = [...(result.health.coverage ?? [])]
  for (const pair of pairs) {
    if (!coverage.some((item) => item.direction === pair.direction && item.date === pair.date)) {
      coverage.push({ ...pair, status: 'error', checkedAt: result.health.checkedAt ?? new Date().toISOString(),
        message: result.health.message || 'Источник не подтвердил запрошенную дату' })
    }
  }
  return { ...result, health: { ...result.health, coverage } }
}

export async function collectPairs(base: Pick<SourceHealth, 'id' | 'name' | 'url' | 'kind'>, pairs: Array<{ direction: Direction; date: string }>, task: (direction: Direction, date: string) => Promise<Trip[]>): Promise<SourceResult> {
  const coverage: SourceCoverage[] = []
  let stop = false
  const failures = new Map<Direction, number>()
  const batches = await mapConcurrent(pairs, 2, async ({ direction, date }): Promise<Trip[]> => {
    try {
      if (stop || (failures.get(direction) ?? 0) >= 3) throw new Error('Последующие запросы остановлены после запрета или повторных сбоев направления')
      sourceSignal()?.throwIfAborted()
      const trips = await task(direction, date)
      if (trips.some((trip) => trip.direction !== direction || trip.serviceDate !== date)) throw new Error('Источник вернул другое направление или дату')
      coverage.push({ direction, date, checkedAt: new Date().toISOString(), status: 'ok' })
      failures.set(direction, 0)
      return trips
    } catch (error) {
      // HTTP blocks/exhausted server retries stop the source. One unrecognised date
      // must not discard other dates or the opposite direction; three failures open its circuit.
      if (error instanceof HttpError || sourceSignal()?.aborted) stop = true
      failures.set(direction, (failures.get(direction) ?? 0) + 1)
      coverage.push({ direction, date, checkedAt: new Date().toISOString(), status: 'error',
        message: error instanceof Error ? error.message.slice(0, 180) : 'Не удалось проверить дату' })
      return []
    }
  })
  const trips = batches.flat()
  const successful = coverage.filter((item) => item.status === 'ok').map((item) => item.checkedAt).sort()
  return { trips, health: { ...base, status: successful.length === coverage.length ? 'ok' : successful.length ? 'stale' : 'error',
    checkedAt: new Date().toISOString(), lastSuccessAt: successful.at(-1), tripsFound: trips.length, coverage,
    message: coverage.find((item) => item.status === 'error')?.message } }
}
