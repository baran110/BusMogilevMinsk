import { describe, expect, it } from 'vitest'
import { handleTripsRequest, handleProtectedTrips } from '../../functions/api/_service'
import { handleSessionRequest } from '../../functions/api/_auth'
import { fixtureKv, testAuthEnv, TEST_KEY } from '../fixtures/schedule'
import worker from '../../worker'
import { onRequest } from '../../functions/api/trips'
import type { DirectionSnapshot, SnapshotManifest, TripsResponse } from '../../src/types'
import { completeFailedCoverage } from '../../scripts/lib/coverage'
import { buildSnapshots } from '../../scripts/lib/snapshots'

const now = new Date('2026-10-14T09:00:00Z')
const date = '2026-10-15'
const url = `https://site.test/api/trips?direction=mogilev-minsk&date=${date}`
describe('schedule API', () => {
  it('rejects invalid and rolled-over calendar dates and methods', async () => {
    for (const query of ['direction=wrong&date=2026-10-15', 'direction=mogilev-minsk&date=2026-02-31', 'direction=mogilev-minsk&date=nope']) {
      expect((await handleTripsRequest(new Request(`https://site.test/api/trips?${query}`), fixtureKv(date, now), now)).status).toBe(400)
    }
    expect((await handleTripsRequest(new Request(url, { method: 'POST' }), fixtureKv(date, now), now)).status).toBe(405)
  })
  it('returns real-mode validated results privately for both directions', async () => {
    for (const direction of ['mogilev-minsk', 'minsk-mogilev']) {
      const response = await handleTripsRequest(new Request(url.replace('mogilev-minsk', direction)), fixtureKv(date, now), now)
      expect(response.status).toBe(200)
      expect(response.headers.get('Cache-Control')).toBe('private, no-store')
      const body = await response.json() as TripsResponse
      expect(body).toMatchObject({ direction, date, dataMode: 'live', stale: false })
      expect(body.trips).toHaveLength(1)
    }
  })
  it('distinguishes missing or unavailable storage from a confirmed empty date', async () => {
    expect((await handleTripsRequest(new Request(url), { get: async () => null }, now)).status).toBe(503)
    expect((await handleTripsRequest(new Request(url), { get: async () => { throw new Error('KV failed') } }, now)).status).toBe(503)
    const kv = fixtureKv(date, now)
    const manifest = await kv.get<SnapshotManifest>('manifest:active', 'json')
    const snapshot = await kv.get<DirectionSnapshot>('out', 'json')
    const emptyKv = fixtureKv(date, now, new Map<string, unknown>([['manifest:active', manifest], ['out', { ...snapshot, trips: [] }]]))
    expect((await handleTripsRequest(new Request(url), emptyKv, now)).status).toBe(200)
    expect((await handleTripsRequest(new Request(url.replace(date, '2026-10-16')), emptyKv, now)).status).toBe(503)
  })
  it('does not refresh old price or seats when a snapshot gets a new timestamp', async () => {
    const old = new Date(now.getTime() - 2 * 86400_000)
    const kv = fixtureKv(date, old)
    const manifest = await kv.get<SnapshotManifest>('manifest:active', 'json')
    const snapshot = (await kv.get<DirectionSnapshot>('out', 'json'))!
    const republished = fixtureKv(date, now, new Map([['manifest:active', { ...manifest, generatedAt: now.toISOString() }], ['out', { ...snapshot, generatedAt: now.toISOString() }]]))
    const response = await handleTripsRequest(new Request(url), republished, now)
    expect(response.status).toBe(200)
    const body = await response.json() as TripsResponse
    expect(body.stale).toBe(true)
    expect(body.trips[0]).toMatchObject({ lastSeenAt: old.toISOString(), price: null, availability: 'unknown', lastKnown: true })
    expect(body.trips[0].seats).toBeUndefined()
  })
  it('reports a partial result for the selected date rather than a different date', async () => {
    const kv = fixtureKv(date, now)
    const manifest = (await kv.get<SnapshotManifest>('manifest:active', 'json'))!
    const snapshot = (await kv.get<DirectionSnapshot>('out', 'json'))!
    const health = { ...snapshot.sources[0], status: 'stale' as const, coverage: [
      { direction: snapshot.direction, date, status: 'ok' as const, checkedAt: now.toISOString() },
      { direction: snapshot.direction, date: '2026-10-16', status: 'error' as const, checkedAt: now.toISOString() },
    ] }
    const values = new Map<string, unknown>([['manifest:active', manifest], ['out', { ...snapshot, sources: [health] }]])
    const response = await handleTripsRequest(new Request(url), fixtureKv(date, now, values), now)
    expect(await response.json()).toMatchObject({ partial: false })
    health.coverage[0].status = 'error'
    const partial = await handleTripsRequest(new Request(url), fixtureKv(date, now, values), now)
    expect(await partial.json()).toMatchObject({ partial: true })
  })
  it('does not reuse a recent empty confirmation after a source fails before returning any dates', async () => {
    const previousKv = fixtureKv(date, new Date(now.getTime() - 5 * 60000))
    const previous = (await previousKv.get<DirectionSnapshot>('out', 'json'))!
    previous.trips = []
    const failed = completeFailedCoverage({ trips: [], health: { ...previous.sources[0], coverage: undefined,
      status: 'error', checkedAt: now.toISOString(), message: 'Нет ответа источника' } }, [{ direction: previous.direction, date }])
    const { manifest, snapshots } = buildSnapshots([failed], { 'mogilev-minsk': previous }, now, 'near')
    const values = new Map<string, unknown>([['manifest:active', manifest], ...snapshots.map((snapshot): [string, unknown] =>
      [manifest.directions[snapshot.direction], snapshot])])
    expect((await handleTripsRequest(new Request(url), fixtureKv(date, now, values), now)).status).toBe(503)
  })
  it('rejects a corrupt snapshot and uses an explicitly referenced previous version', async () => {
    const kv = fixtureKv(date, now)
    const manifest = (await kv.get<SnapshotManifest>('manifest:active', 'json'))!
    const snapshot = (await kv.get<DirectionSnapshot>('out', 'json'))!
    const values = new Map<string, unknown>([['manifest:active', { ...manifest, previousDirections: { 'mogilev-minsk': 'previous' } }],
      ['out', { ...snapshot, trips: [{ ...snapshot.trips[0], bookingOptions: [{ ...snapshot.trips[0].bookingOptions[0], url: 'javascript:alert(1)' }] }] }], ['previous', snapshot]])
    const response = await handleTripsRequest(new Request(url), fixtureKv(date, now, values), now)
    expect(response.status).toBe(200)
    expect(await response.json()).toMatchObject({ usedBackup: true, stale: true })
  })
})

describe('both hosting entrypoints enforce server access', () => {
  it('rejects frontend grants and serves an authenticated request identically', async () => {
    const env = { ...await testAuthEnv(), TRIPS_KV: fixtureKv(date), ASSETS: { fetch: async () => new Response('asset') } }
    const noCookie = new Request(url, { headers: { 'X-Access-Hash': 'public-frontend-grant' } })
    expect((await handleProtectedTrips(noCookie, env)).status).toBe(401)
    expect((await worker.fetch(noCookie, env as never)).status).toBe(401)
    const pagesContext = { request: noCookie, env } as unknown as Parameters<typeof onRequest>[0]
    expect((await onRequest(pagesContext)).status).toBe(401)
    const session = await handleSessionRequest(new Request('https://site.test/api/session', { method: 'POST',
      headers: { Origin: 'https://site.test', 'Content-Type': 'application/json' }, body: JSON.stringify({ key: TEST_KEY }) }), env)
    const request = new Request(url, { headers: { Cookie: session.headers.get('Set-Cookie')!.split(';')[0] } })
    const pages = await onRequest({ ...pagesContext, request } as unknown as Parameters<typeof onRequest>[0])
    const mirror = await worker.fetch(request, env as never)
    expect(pages.status).toBe(200)
    expect(await pages.json()).toEqual(await mirror.json())
  })
})
