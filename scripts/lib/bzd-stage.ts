import { addDays, isDeparted, isValidDate, isValidInstant, localDate } from '../../src/lib/date'
import { DIRECTIONS, isSnapshot } from '../../src/lib/validation'
import { observationAge, SCHEDULE_MAX_AGE_MS } from '../../src/lib/trips'
import type { Direction, SourceCoverage, Trip } from '../../src/types'
import { completeFailedCoverage } from './coverage'
import { readKv, writeKvEntry } from './kv'
import { buildSnapshots } from './snapshots'
import type { SourceResult } from './source'

export const BZD_SOURCE = { id: 'bzd', name: 'БЖД', kind: 'carrier' as const, url: 'https://pass.rw.by/ru/' }
export interface BzdBatch { scope: 'near' | 'far'; part: number; anchorDate: string }
export interface BzdStage extends BzdBatch {
  schemaVersion: 1
  sourceId: 'bzd'
  generatedAt: string
  result: SourceResult
  /** Last confirmed date observations, including empty ones, survive a later error. */
  confirmedCoverage: SourceCoverage[]
}
export type DatePair = { direction: Direction; date: string }

export function bzdBatches(scope: BzdBatch['scope'], anchorDate = localDate()): BzdBatch[] {
  return Array.from({ length: scope === 'near' ? 1 : 6 }, (_, part) => ({ scope, part, anchorDate }))
}

export function bzdBatchPairs(batch: BzdBatch): DatePair[] {
  if (!isValidDate(batch.anchorDate) || !Number.isInteger(batch.part) || batch.part < 0
    || !(batch.scope === 'near' ? batch.part === 0 : batch.scope === 'far' && batch.part < 6)) throw new Error('Неверный пакет БЖД')
  const start = batch.scope === 'near' ? 0 : 3 + batch.part * 5
  const length = batch.scope === 'near' ? 3 : Math.min(5, 30 - start)
  return Array.from({ length }, (_, day) => DIRECTIONS.map((direction) => ({ direction, date: addDays(batch.anchorDate, start + day) }))).flat()
}

export function bzdStageKey(batch: BzdBatch): string {
  bzdBatchPairs(batch)
  return batch.scope === 'near' ? 'source:bzd:near' : `source:bzd:far:${batch.part}`
}
const pairKey = (pair: DatePair) => `${pair.direction}/${pair.date}`

export function isBzdStage(value: unknown, now = new Date()): value is BzdStage {
  try {
    if (!value || typeof value !== 'object') return false
    const stage = value as BzdStage
    if (stage.schemaVersion !== 1 || stage.sourceId !== 'bzd' || !isValidInstant(stage.generatedAt)
      || Date.parse(stage.generatedAt) > now.getTime() + 60_000 || !stage.result
      || Buffer.byteLength(JSON.stringify(stage), 'utf8') > 2 * 1024 * 1024) return false
    const pairs = bzdBatchPairs(stage)
    const expected = new Set(pairs.map(pairKey))
    const { health, trips } = stage.result
    if (health?.id !== 'bzd' || health.kind !== 'carrier' || health.status === 'unchecked'
      || health.coverage?.length !== pairs.length || new Set(health.coverage.map(pairKey)).size !== pairs.length
      || !health.coverage.every((item) => expected.has(pairKey(item)) && Date.parse(item.checkedAt) <= Date.parse(stage.generatedAt))) return false
    if (!Array.isArray(stage.confirmedCoverage) || new Set(stage.confirmedCoverage.map(pairKey)).size !== stage.confirmedCoverage.length
      || !stage.confirmedCoverage.every((item) => expected.has(pairKey(item)) && item.status === 'ok' && isValidInstant(item.checkedAt)
        && Date.parse(item.checkedAt) <= Date.parse(health.coverage!.find((attempt) => pairKey(attempt) === pairKey(item))!.checkedAt))
      || !health.coverage.filter((item) => item.status === 'ok').every((item) => stage.confirmedCoverage.some((confirmed) => pairKey(confirmed) === pairKey(item) && confirmed.checkedAt === item.checkedAt))) return false
    if (!DIRECTIONS.every((direction) => isSnapshot({ schemaVersion: 2, direction, generatedAt: stage.generatedAt,
      sources: [health], trips: trips.filter((trip) => trip.direction === direction) }, direction))) return false
    return trips.every((trip) => expected.has(pairKey({ direction: trip.direction, date: trip.serviceDate })) && trip.vehicleType === 'train'
      && trip.bookingOptions.every((option) => option.sourceId === 'bzd' && !!option.observedAt
        && Date.parse(option.observedAt) <= Date.parse(stage.confirmedCoverage.find((item) => item.direction === trip.direction && item.date === trip.serviceDate)!.checkedAt)
        && Date.parse(trip.lastSeenAt) <= Date.parse(stage.generatedAt)
        && [option.priceObservedAt, option.availabilityObservedAt].every((time) => time === undefined || Date.parse(time) <= Date.parse(option.observedAt!))))
  } catch { return false }
}

export function createBzdStage(batch: BzdBatch, result: SourceResult, previous: unknown, now = new Date()): BzdStage {
  const pairs = bzdBatchPairs(batch)
  const completed = completeFailedCoverage(result, pairs)
  const validPrevious = isBzdStage(previous, now) && bzdStageKey(previous) === bzdStageKey(batch) ? previous : undefined
  const prior = Object.fromEntries(DIRECTIONS.map((direction) => [direction, validPrevious ? {
    schemaVersion: 2 as const, direction, generatedAt: validPrevious.generatedAt,
    trips: validPrevious.result.trips.filter((trip) => trip.direction === direction), sources: [validPrevious.result.health],
  } : undefined]))
  const { snapshots } = buildSnapshots([completed], prior, now, batch.scope === 'near' ? 'near' : 'full')
  const expected = new Set(pairs.map(pairKey))
  const confirmedCoverage = pairs.flatMap((pair) => {
    const current = completed.health.coverage?.find((item) => pairKey(item) === pairKey(pair) && item.status === 'ok')
    const old = validPrevious?.confirmedCoverage.find((item) => pairKey(item) === pairKey(pair))
    return current ? [current] : old ? [old] : []
  })
  const stage: BzdStage = { ...batch, schemaVersion: 1, sourceId: 'bzd', generatedAt: now.toISOString(), confirmedCoverage, result: {
    trips: snapshots.flatMap((snapshot) => snapshot.trips).filter((trip) => expected.has(pairKey({ direction: trip.direction, date: trip.serviceDate }))),
    health: { ...snapshots[0].sources[0], coverage: completed.health.coverage },
  } }
  if (!isBzdStage(stage, now)) throw new Error('Пакет БЖД не прошёл проверку; запись остановлена')
  return stage
}

/** Select by actual date observations, never by package publication time. */
export function combineBzdStages(values: unknown[], pairs: DatePair[], now = new Date()): SourceResult {
  const stages = values.filter((value): value is BzdStage => isBzdStage(value, now) && observationAge(value.generatedAt, now) <= SCHEDULE_MAX_AGE_MS)
  const trips: Trip[] = []
  const coverage: SourceCoverage[] = []
  const confirmedCoverage: SourceCoverage[] = []
  for (const pair of pairs) {
    const candidates = stages.flatMap((stage) => stage.result.health.coverage!.filter((item) => pairKey(item) === pairKey(pair)).map((item) => ({ stage, item })))
      .sort((a, b) => Date.parse(b.item.checkedAt) - Date.parse(a.item.checkedAt) || (a.item.status === 'error' ? -1 : 1))
    const latest = candidates[0]
    if (!latest) { coverage.push({ ...pair, checkedAt: now.toISOString(), status: 'error', message: 'Проверенный пакет БЖД отсутствует' }); continue }
    coverage.push(latest.item)
    // Remember the latest successful empty observation even after another failure.
    const confirmed = stages.flatMap((stage) => stage.confirmedCoverage.filter((item) => pairKey(item) === pairKey(pair)).map((item) => ({ stage, item })))
      .sort((a, b) => Date.parse(b.item.checkedAt) - Date.parse(a.item.checkedAt) || Date.parse(b.stage.generatedAt) - Date.parse(a.stage.generatedAt))[0]
    if (!confirmed) continue
    confirmedCoverage.push(confirmed.item)
    for (const trip of confirmed.stage.result.trips) {
      if (trip.direction !== pair.direction || trip.serviceDate !== pair.date || isDeparted(trip.departureAt, now)) continue
      const observedAt = trip.bookingOptions[0].observedAt!
      if (observationAge(observedAt, now) > SCHEDULE_MAX_AGE_MS || Date.parse(observedAt) > Date.parse(latest.item.checkedAt)) continue
      trips.push({
        ...trip, bookingOptions: trip.bookingOptions.map((option) => ({ ...option, lastKnown: latest.item.status === 'error' || option.lastKnown })),
      })
    }
  }
  const successful = coverage.filter((item) => item.status === 'ok')
  const fresh = successful.filter((item) => observationAge(item.checkedAt, now) <= (item.date < addDays(localDate(now), 3) ? 15 : 75) * 60000)
  return { trips, confirmedCoverage, health: { ...BZD_SOURCE, checkedAt: now.toISOString(), coverage, tripsFound: trips.length,
    status: fresh.length === pairs.length ? 'ok' : successful.length || trips.length ? 'stale' : 'error',
    lastSuccessAt: successful.map((item) => item.checkedAt).sort().at(-1),
    message: fresh.length === pairs.length ? undefined : 'Часть дат БЖД не подтверждена или требует обновления' } }
}

export async function readBzdStagedResult(pairs: DatePair[], now = new Date()): Promise<SourceResult> {
  const batches = [...bzdBatches('near'), ...bzdBatches('far')]
  const reads = await Promise.allSettled(batches.map(async (batch) => {
    const value = await readKv<unknown>(bzdStageKey(batch))
    return isBzdStage(value, now) && bzdStageKey(value) === bzdStageKey(batch) ? value : undefined
  }))
  return combineBzdStages(reads.map((read) => read.status === 'fulfilled' ? read.value : undefined), pairs, now)
}

export async function saveBzdStage(stage: BzdStage): Promise<void> {
  if (!isBzdStage(stage)) throw new Error('Пакет БЖД не прошёл проверку')
  const key = bzdStageKey(stage)
  await writeKvEntry(key, stage, 7 * 86400)
  const stored = await readKv<unknown>(key)
  if (!isBzdStage(stored) || JSON.stringify(stored) !== JSON.stringify(stage)) throw new Error('Запись пакета БЖД не подтверждена')
}
