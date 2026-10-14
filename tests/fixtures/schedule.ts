import { addMinutes, minskIso } from '../../src/lib/date'
import type { Direction, DirectionSnapshot, SnapshotManifest, SourceHealth, Trip } from '../../src/types'
import type { AuthEnv } from '../../functions/api/_auth'
import type { KvReader } from '../../functions/api/_service'

export const TEST_KEY = 'MM-TEST-ONLY-abcdefghijklmnopqrstuvwxyz123456789'
export async function testAuthEnv(): Promise<AuthEnv> {
  const hash = Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(TEST_KEY))), (byte) => byte.toString(16).padStart(2, '0')).join('')
  return { ACCESS_KEYS: JSON.stringify([{ id: 'test-passenger', hash }]), SESSION_SECRET: 'test-only-session-secret-do-not-use-in-production-123456789' }
}

export function fixtureTrip(date: string, direction: Direction = 'mogilev-minsk', now = new Date()): Trip {
  const seen = now.toISOString()
  const departureAt = minskIso(date, '12:00')
  return { id: `fixture:${direction}:${date}`, direction, serviceDate: date, departureAt, arrivalAt: addMinutes(departureAt, 150),
    durationMinutes: 150, carrierId: 'test-carrier', carrierName: 'Тестовый перевозчик', vehicleType: 'minibus',
    originStop: direction === 'mogilev-minsk' ? 'Могилёв' : 'Минск', destinationStop: direction === 'mogilev-minsk' ? 'Минск' : 'Могилёв',
    price: 25, currency: 'BYN', availability: 'available', seats: 3, lastSeenAt: seen,
    bookingOptions: [{ sourceId: 'avtoslava', sourceName: 'Тестовый источник', sourceKind: 'carrier', url: 'https://avto-slava.by/',
      price: 25, currency: 'BYN', availability: 'available', seats: 3, observedAt: seen, priceObservedAt: seen, availabilityObservedAt: seen }] }
}

export function fixtureKv(date: string, now = new Date(), valuesOverride?: Map<string, unknown>): KvReader {
  const generatedAt = now.toISOString()
  const sources: SourceHealth[] = [{ id: 'avtoslava', name: 'Тестовый источник', kind: 'carrier', url: 'https://avto-slava.by/',
    status: 'ok', checkedAt: generatedAt, lastSuccessAt: generatedAt,
    coverage: (['mogilev-minsk', 'minsk-mogilev'] as const).map((direction) => ({ direction, date, checkedAt: generatedAt, status: 'ok' })) }]
  const manifest: SnapshotManifest = { schemaVersion: 2, version: 'fixture-version', generatedAt,
    directions: { 'mogilev-minsk': 'out', 'minsk-mogilev': 'back' }, sources }
  const snapshot: DirectionSnapshot = { schemaVersion: 2, direction: 'mogilev-minsk', generatedAt, trips: [fixtureTrip(date, 'mogilev-minsk', now)], sources }
  const values = valuesOverride ?? new Map<string, unknown>([['manifest:active', manifest], ['out', snapshot],
    ['back', { ...snapshot, direction: 'minsk-mogilev', trips: [fixtureTrip(date, 'minsk-mogilev', now)] }]])
  return { get: async <T>(key: string) => values.get(key) as T ?? null }
}
