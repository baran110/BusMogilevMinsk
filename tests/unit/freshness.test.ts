import { describe, expect, it } from 'vitest'
import { buildSnapshots } from '../../scripts/lib/snapshots'
import { chooseBestBooking, mergeExactTrips, projectTrip } from '../../src/lib/trips'
import { fixtureTrip } from '../fixtures/schedule'
import type { DirectionSnapshot, SourceHealth } from '../../src/types'

const now = new Date('2026-10-14T09:00:00Z')
const source: SourceHealth = { id: 'avtoslava', name: 'АвтоСлава', kind: 'carrier', url: 'https://avto-slava.by/', status: 'error', checkedAt: now.toISOString() }
describe('per-offer freshness and retention', () => {
  it('preserves real observation age during repeated failed publications', () => {
    const old = new Date(now.getTime() - 2 * 86400_000)
    const trip = fixtureTrip('2026-10-15', 'mogilev-minsk', old)
    const snapshot: DirectionSnapshot = { schemaVersion: 2, direction: trip.direction, generatedAt: now.toISOString(), trips: [trip], sources: [source] }
    const first = buildSnapshots([{ health: source, trips: [] }], { 'mogilev-minsk': snapshot }, now)
    const second = buildSnapshots([{ health: source, trips: [] }], { 'mogilev-minsk': first.snapshots[0] }, new Date(now.getTime() + 10 * 60_000))
    const projected = projectTrip(second.snapshots[0].trips[0], now)!
    expect(projected).toMatchObject({ price: null, availability: 'unknown', lastKnown: true, lastSeenAt: old.toISOString() })
    expect(second.manifest.sources[0].status).toBe('stale')
  })
  it('removes results older than seven days and keeps an unrequested distant date', () => {
    const trip = fixtureTrip('2026-10-30', 'mogilev-minsk', new Date(now.getTime() - 8 * 86400_000))
    expect(projectTrip(trip, now)).toBeNull()
    const recent = fixtureTrip('2026-10-30', 'mogilev-minsk', now)
    const snapshot: DirectionSnapshot = { schemaVersion: 2, direction: trip.direction, generatedAt: now.toISOString(), trips: [recent], sources: [] }
    const result = buildSnapshots([{ health: { ...source, status: 'ok', coverage: [{ direction: trip.direction, date: '2026-10-15', checkedAt: now.toISOString(), status: 'ok' }] }, trips: [] }], { 'mogilev-minsk': snapshot }, now, 'near')
    expect(result.snapshots[0].trips).toHaveLength(1)
  })
  it('a confirmed empty date removes only that source and date', () => {
    const trip = fixtureTrip('2026-10-15', 'mogilev-minsk', now)
    const snapshot: DirectionSnapshot = { schemaVersion: 2, direction: trip.direction, generatedAt: now.toISOString(), trips: [trip], sources: [] }
    const result = buildSnapshots([{ health: { ...source, status: 'ok', coverage: [{ direction: trip.direction, date: trip.serviceDate, checkedAt: now.toISOString(), status: 'ok' }] }, trips: [] }], { 'mogilev-minsk': snapshot }, now)
    expect(result.snapshots[0].trips).toHaveLength(0)
  })
  it('does not infer price or seats from legacy fields without observation stamps', () => {
    const trip = fixtureTrip('2026-10-15', 'mogilev-minsk', now)
    trip.bookingOptions.forEach((option) => { delete option.priceObservedAt; delete option.availabilityObservedAt })
    expect(projectTrip(trip, now)).toMatchObject({ price: null, availability: 'unknown' })
  })
  it('the displayed price and seats belong to the selected seller', () => {
    const trip = fixtureTrip('2026-10-15', 'mogilev-minsk', now)
    const other = { ...trip, id: 'another-source', price: 20, seats: 10, bookingOptions: [{ ...trip.bookingOptions[0], sourceId: 'atlas', sourceKind: 'platform' as const, price: 20, seats: 10, url: 'https://atlasbus.by/' }] }
    const merged = mergeExactTrips([trip, other])[0]
    expect(merged.price).toBe(chooseBestBooking(merged.bookingOptions).price)
    expect(merged.seats).toBe(3)
    expect(mergeExactTrips([trip, { ...trip, id: 'different-vehicle' }])).toHaveLength(2)
  })
})
