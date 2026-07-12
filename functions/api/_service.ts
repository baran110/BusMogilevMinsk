import { isDeparted } from '../../src/lib/date'
import { isSnapshotExpired, isSnapshotStale } from '../../src/lib/trips'
import type { Direction, DirectionSnapshot, SnapshotManifest, TripsResponse } from '../../src/types'

export interface KvReader {
  get<T>(key: string, type: 'json'): Promise<T | null>
}

const directions = new Set<Direction>(['mogilev-minsk', 'minsk-mogilev'])
const datePattern = /^\d{4}-\d{2}-\d{2}$/

function json(body: unknown, status = 200, extra: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json; charset=utf-8', ...extra },
  })
}

export async function handleTripsRequest(request: Request, kv: KvReader, now = new Date()): Promise<Response> {
  const url = new URL(request.url)
  const direction = url.searchParams.get('direction') as Direction | null
  const date = url.searchParams.get('date')
  if (!direction || !directions.has(direction) || !date || !datePattern.test(date) || Number.isNaN(new Date(`${date}T00:00:00Z`).getTime())) {
    return json({ error: 'Укажите direction=mogilev-minsk| minsk-mogilev и date=YYYY-MM-DD' }, 400, { 'Cache-Control': 'no-store' })
  }
  const manifest = await kv.get<SnapshotManifest>('manifest:active', 'json')
  if (!manifest) return json({ error: 'Расписание ещё не загружено' }, 503, { 'Cache-Control': 'no-store', 'Retry-After': '300' })
  const snapshot = await kv.get<DirectionSnapshot>(manifest.directions[direction], 'json')
  if (!snapshot || isSnapshotExpired(snapshot.generatedAt, now)) {
    return json({ error: 'Актуальное расписание временно недоступно' }, 503, { 'Cache-Control': 'no-store', 'Retry-After': '300' })
  }
  const payload: TripsResponse = {
    direction,
    date,
    generatedAt: snapshot.generatedAt,
    stale: isSnapshotStale(snapshot.generatedAt, now),
    trips: snapshot.trips.filter((trip) => trip.serviceDate === date && !isDeparted(trip.departureAt, now)),
    sources: snapshot.sources,
  }
  return json(payload, 200, {
    'Cache-Control': 'public, max-age=300, s-maxage=300, stale-while-revalidate=900',
    'X-Data-Version': manifest.version,
    'X-Content-Type-Options': 'nosniff',
  })
}
