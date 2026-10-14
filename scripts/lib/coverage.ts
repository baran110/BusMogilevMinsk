import { addDays, localDate } from '../../src/lib/date'
import type { Direction, SourceCoverage, SourceHealth, Trip } from '../../src/types'
import { sourceSignal, mapConcurrent } from './runtime'
import type { SourceResult } from './source'

export function requestedPairs(days: number): Array<{ direction: Direction; date: string }> {
  const today = localDate()
  return Array.from({ length: days }, (_, day) => (['mogilev-minsk', 'minsk-mogilev'] as const).map((direction) => ({ direction, date: addDays(today, day) }))).flat()
}

export async function collectPairs(base: Pick<SourceHealth, 'id' | 'name' | 'url' | 'kind'>, pairs: Array<{ direction: Direction; date: string }>, task: (direction: Direction, date: string) => Promise<Trip[]>): Promise<SourceResult> {
  const coverage: SourceCoverage[] = []
  let stop = false
  const batches = await mapConcurrent(pairs, 2, async ({ direction, date }): Promise<Trip[]> => {
    try {
      if (stop) throw new Error('Последующие запросы остановлены после запрета или сбоя источника')
      sourceSignal()?.throwIfAborted()
      const trips = await task(direction, date)
      if (trips.some((trip) => trip.direction !== direction || trip.serviceDate !== date)) throw new Error('Источник вернул другое направление или дату')
      coverage.push({ direction, date, checkedAt: new Date().toISOString(), status: 'ok' })
      return trips
    } catch (error) {
      // Do not keep hammering a blocked source or a changed schema across thirty dates.
      stop = true
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
