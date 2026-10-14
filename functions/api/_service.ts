import { addDays, isDeparted, isValidDate, localDate } from '../../src/lib/date'
import { isSnapshotExpired, isSnapshotStale, observationAge, projectTrip } from '../../src/lib/trips'
import { isDirection, isManifest, isSnapshot } from '../../src/lib/validation'
import type { Direction, DirectionSnapshot, SnapshotManifest, TripsResponse } from '../../src/types'
import { authenticate, json, type AuthEnv } from './_auth'

export interface KvReader {
  get<T>(key: string, type: 'json'): Promise<T | null>
}

export async function handleTripsRequest(request: Request, kv: KvReader, now = new Date()): Promise<Response> {
  if (request.method !== 'GET') return json({ error: 'Метод не поддерживается' }, 405, { Allow: 'GET' })
  const url = new URL(request.url)
  const direction = url.searchParams.get('direction') as Direction | null
  const date = url.searchParams.get('date')
  if (!isDirection(direction) || !isValidDate(date)) {
    return json({ error: 'Укажите direction=mogilev-minsk| minsk-mogilev и date=YYYY-MM-DD' }, 400, { 'Cache-Control': 'no-store' })
  }
  try {
  const rawManifest = await kv.get<SnapshotManifest>('manifest:active', 'json')
  const manifest: SnapshotManifest = isManifest(rawManifest) ? rawManifest : { schemaVersion: 2, version: 'backup', generatedAt: now.toISOString(),
    directions: { 'mogilev-minsk': 'backup:mogilev-minsk', 'minsk-mogilev': 'backup:minsk-mogilev' }, sources: [] }
  let snapshot = await kv.get<DirectionSnapshot>(manifest.directions[direction], 'json')
  let usedBackup = !isManifest(rawManifest)
  if (!isSnapshot(snapshot, direction) || isSnapshotExpired(snapshot.generatedAt, now)) {
    const previousKey = manifest.previousDirections?.[direction]
    snapshot = previousKey ? await kv.get<DirectionSnapshot>(previousKey, 'json') : null
    if (!isSnapshot(snapshot, direction) || isSnapshotExpired(snapshot.generatedAt, now)) {
      snapshot = await kv.get<DirectionSnapshot>(`backup:${direction}`, 'json')
    }
    usedBackup = true
  }
  if (!isSnapshot(snapshot, direction) || isSnapshotExpired(snapshot.generatedAt, now)) {
    return json({ error: 'Актуальное расписание временно недоступно' }, 503, { 'Cache-Control': 'no-store', 'Retry-After': '300' })
  }
  const trips = snapshot.trips.filter((trip) => trip.serviceDate === date && !isDeparted(trip.departureAt, now))
    .flatMap((trip) => { const projected = projectTrip(trip, now); return projected ? [projected] : [] })
  const relevantSources = snapshot.sources.filter((source) => source.coverage?.some((item) => item.direction === direction && item.date === date))
  const dateMaxAge = date < addDays(localDate(now), 3) ? 15 * 60_000 : 75 * 60_000
  const hasConfirmedDate = relevantSources.some((source) => source.coverage?.some((item) => item.direction === direction && item.date === date && item.status === 'ok' && observationAge(item.checkedAt, now) <= dateMaxAge))
  if (!trips.length && !hasConfirmedDate) return json({ error: 'Данные на эту дату пока не подтверждены' }, 503, { 'Retry-After': '300' })
  const payload: TripsResponse = {
    direction,
    date,
    generatedAt: snapshot.generatedAt,
    dataMode: 'live',
    stale: usedBackup || isSnapshotStale(snapshot.generatedAt, now) || trips.some((trip) => trip.lastKnown),
    partial: snapshot.sources.some((source) => source.status === 'error' || source.status === 'stale' || source.coverage?.some((item) => item.direction === direction && item.date === date && item.status === 'error')),
    usedBackup,
    trips,
    sources: snapshot.sources,
  }
  return json(payload, 200, {
    'Cache-Control': 'private, no-store',
    'X-Data-Version': manifest.version,
    'X-Content-Type-Options': 'nosniff',
  })
  } catch {
    return json({ error: 'Хранилище расписаний временно недоступно' }, 503, { 'Retry-After': '300' })
  }
}

export async function handleProtectedTrips(request: Request, env: AuthEnv & { TRIPS_KV: KvReader }, now = new Date()): Promise<Response> {
  return await authenticate(request, env, now) ?? handleTripsRequest(request, env.TRIPS_KV, now)
}
