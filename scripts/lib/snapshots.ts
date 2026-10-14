import { isDeparted } from '../../src/lib/date'
import { mergeExactTrips, observationAge, SCHEDULE_MAX_AGE_MS } from '../../src/lib/trips'
import { DIRECTIONS, isTrip } from '../../src/lib/validation'
import type { Direction, DirectionSnapshot, SnapshotManifest, SourceHealth, Trip } from '../../src/types'
import type { SourceResult } from './source'

export function buildSnapshots(results: SourceResult[], previous: Partial<Record<Direction, DirectionSnapshot>>, now = new Date(), mode: 'near' | 'full' = 'full') {
  const currentTrips: Trip[] = results.flatMap((result) => result.trips)
  if (currentTrips.some((trip) => !isTrip(trip))) throw new Error('Публикация остановлена: некорректные рейсы или ссылки')
  const retainedIds = new Set<string>()
  for (const direction of DIRECTIONS) {
    for (const trip of previous[direction]?.trips ?? []) {
      if (!isTrip(trip) || isDeparted(trip.departureAt, now)) continue
      const options = trip.bookingOptions.flatMap((option) => {
        const observedAt = option.observedAt ?? trip.lastSeenAt
        if (observationAge(observedAt, now) > SCHEDULE_MAX_AGE_MS) return []
        const result = results.find((item) => item.health.id === option.sourceId)
        const coverage = result?.health.coverage?.find((item) => item.direction === direction && item.date === trip.serviceDate)
        // Only a successful observation of this exact date replaces its old offers, including an empty result.
        if (coverage?.status === 'ok') return []
        if (!result || result.health.status === 'unchecked' || !coverage) {
          if (result?.health.status === 'ok' && !result.health.coverage) return []
          const failed = result?.health.status === 'error' || result?.health.status === 'stale'
          if (failed) retainedIds.add(option.sourceId)
          return [{ ...option, observedAt, lastKnown: failed || option.lastKnown }]
        }
        retainedIds.add(option.sourceId)
        return [{ ...option, observedAt, lastKnown: true }]
      })
      if (options.length) currentTrips.push({ ...trip, bookingOptions: options })
    }
  }
  const sources: SourceHealth[] = results.map(({ health }) => {
    const previousHealth = Object.values(previous).flatMap((snapshot) => snapshot?.sources ?? []).find((source) => source.id === health.id)
    const coverage = [...(health.coverage ?? [])]
    for (const old of previousHealth?.coverage ?? []) {
      if (observationAge(old.checkedAt, now) <= SCHEDULE_MAX_AGE_MS && !coverage.some((item) => item.date === old.date && item.direction === old.direction)) coverage.push(old)
    }
    return { ...health, coverage, lastSuccessAt: health.lastSuccessAt ?? previousHealth?.lastSuccessAt,
      status: health.status === 'error' && retainedIds.has(health.id) ? 'stale' : health.status }
  })
  const generatedAt = now.toISOString()
  const version = `${generatedAt.replace(/[-:.TZ]/g, '')}-${crypto.randomUUID().slice(0, 8)}`
  const snapshots = DIRECTIONS.map((direction): DirectionSnapshot => ({ schemaVersion: 2, direction, generatedAt,
    trips: mergeExactTrips(currentTrips.filter((trip) => trip.direction === direction && !isDeparted(trip.departureAt, now))), sources }))
  const manifest: SnapshotManifest = { schemaVersion: 2, version, generatedAt, mode, sources,
    directions: { 'mogilev-minsk': `snapshot:${version}:mogilev-minsk`, 'minsk-mogilev': `snapshot:${version}:minsk-mogilev` } }
  return { manifest, snapshots }
}
