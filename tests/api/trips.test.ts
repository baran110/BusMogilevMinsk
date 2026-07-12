import { describe, expect, it } from 'vitest'
import { handleTripsRequest, type KvReader } from '../../functions/api/_service'
import { buildDemoTrips } from '../../src/data/demo'
import type { DirectionSnapshot, SnapshotManifest } from '../../src/types'

function makeKv(generatedAt: string): KvReader {
  const trips = buildDemoTrips('mogilev-minsk', 2)
  const manifest: SnapshotManifest = { schemaVersion: 1, version: 'v1', generatedAt, directions: { 'mogilev-minsk': 'out', 'minsk-mogilev': 'back' }, sources: [] }
  const snapshot: DirectionSnapshot = { schemaVersion: 1, direction: 'mogilev-minsk', generatedAt, trips, sources: [] }
  const values = new Map<string, unknown>([['manifest:active', manifest], ['out', snapshot], ['back', { ...snapshot, direction: 'minsk-mogilev', trips: [] }]])
  return { get: async <T>(key: string) => (values.get(key) as T | undefined) ?? null }
}

describe('Pages trips API', () => {
  it('rejects invalid parameters', async () => {
    const response = await handleTripsRequest(new Request('https://site.test/api/trips?direction=wrong&date=nope'), makeKv(new Date().toISOString()))
    expect(response.status).toBe(400)
  })

  it('returns filtered data with cache headers', async () => {
    const now = new Date()
    const date = new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Minsk' }).format(now)
    const response = await handleTripsRequest(new Request(`https://site.test/api/trips?direction=mogilev-minsk&date=${date}`), makeKv(now.toISOString()), new Date(`${date}T00:00:00Z`))
    expect(response.status).toBe(200)
    expect(response.headers.get('Cache-Control')).toContain('s-maxage=300')
    const body = await response.json() as { direction: string; trips: unknown[] }
    expect(body.direction).toBe('mogilev-minsk')
    expect(body.trips.length).toBeGreaterThan(0)
  })

  it('does not serve data older than 24 hours', async () => {
    const generated = '2026-07-10T00:00:00Z'
    const response = await handleTripsRequest(new Request('https://site.test/api/trips?direction=mogilev-minsk&date=2026-07-12'), makeKv(generated), new Date('2026-07-12T01:00:00Z'))
    expect(response.status).toBe(503)
  })
})
