import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import registry from '../../data/sources.json'
import { auditSmokePayload, runApiSmoke, SMOKE_ORIGINS, smokePlan } from '../../scripts/lib/api-smoke'
import { dateRange } from '../../src/lib/date'
import { fixtureTrip, testAuthEnv, TEST_KEY } from '../fixtures/schedule'
import { onRequest as pagesTrips } from '../../functions/api/trips'
import { onRequest as pagesSession } from '../../functions/api/session'
import { onRequest as pagesHealth } from '../../functions/api/health'
import worker from '../../worker'
import type { DirectionSnapshot, SnapshotManifest, SourceHealth, TripsResponse } from '../../src/types'

const now = new Date('2026-11-13T21:10:00Z') // 14 November in Minsk.
const today = '2026-11-14'
const dates = dateRange(today, 30)
const sources: SourceHealth[] = registry.filter((source) => source.enabled && !['link-only', 'availability'].includes(source.adapter)).map((source) => ({
  id: source.id, name: source.name, kind: source.kind as SourceHealth['kind'], url: source.url, status: 'ok',
  checkedAt: now.toISOString(), lastSuccessAt: now.toISOString(),
  coverage: dates.flatMap((date) => (['mogilev-minsk', 'minsk-mogilev'] as const).map((direction) => ({
    direction, date, checkedAt: now.toISOString(), status: 'ok' as const,
  }))),
}))

beforeEach(() => { vi.useFakeTimers(); vi.setSystemTime(now) })
afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks() })

async function fixtureTransport(intercept?: (request: Request, next: () => Promise<Response>) => Promise<Response>, missingSnapshots = false) {
  const env = await testAuthEnv()
  const manifest: SnapshotManifest = { schemaVersion: 2, version: 'smoke-fixture', generatedAt: now.toISOString(), sources,
    directions: { 'mogilev-minsk': 'out', 'minsk-mogilev': 'back' } }
  const values = new Map<string, unknown>([['manifest:active', manifest]])
  for (const [direction, key] of Object.entries(manifest.directions)) {
    const snapshot: DirectionSnapshot = { schemaVersion: 2, direction: direction as DirectionSnapshot['direction'], generatedAt: now.toISOString(), sources,
      trips: dates.map((date) => ({ ...fixtureTrip(date, direction as DirectionSnapshot['direction'], now), carrierName: TEST_KEY })) }
    if (!missingSnapshots) values.set(key, snapshot)
  }
  const boundEnv = { ...env, TRIPS_KV: { get: async <T>(key: string) => values.get(key) as T ?? null } }
  const cookies: string[] = []
  const transport = vi.fn<typeof fetch>(async (input, init) => {
    const request = new Request(input, init)
    const url = new URL(request.url)
    expect(SMOKE_ORIGINS).toContain(url.origin)
    expect(init?.redirect).toBe('manual')
    expect(init?.credentials).toBe('omit')
    const next = async (): Promise<Response> => {
      if (url.origin === SMOKE_ORIGINS[1]) return worker.fetch(request, boundEnv as never)
      const handler = url.pathname === '/api/session' ? pagesSession : url.pathname === '/api/health' ? pagesHealth : pagesTrips
      return await handler({ request, env: boundEnv } as never)
    }
    const response = await (intercept ? intercept(request, next) : next())
    const cookie = response.headers.get('Set-Cookie')
    if (cookie) cookies.push(cookie)
    return response
  })
  return { transport, cookies }
}

function payload(): TripsResponse {
  return { direction: 'mogilev-minsk', date: today, generatedAt: now.toISOString(), dataMode: 'live', stale: false,
    partial: false, usedBackup: false, trips: [fixtureTrip(today, 'mogilev-minsk', now)], sources: structuredClone(sources) }
}

describe('authorized API smoke checker, isolated from the network', () => {
  it('checks all 120 date/direction/domain combinations through real entrypoints and never reports credentials or response details', async () => {
    const { transport, cookies } = await fixtureTransport()
    const report = await runApiSmoke(TEST_KEY, { fetch: transport, pauseMs: 0 })

    expect(report.ready).toBe(true)
    expect(report.rows).toHaveLength(120)
    expect(new Set(report.rows.map((row) => `${row.origin}/${row.direction}/${row.date}`)).size).toBe(120)
    expect(report.access).toHaveLength(14)
    expect(report.health).toHaveLength(8)
    expect(report).toMatchObject({ startDate: today, endDate: '2026-12-13' })
    expect(transport).toHaveBeenCalledTimes(142)
    const serialized = JSON.stringify(report)
    expect(serialized).not.toContain(TEST_KEY) // Also placed in the fixture carrierName.
    expect(serialized).not.toContain('bookingOptions')
    for (const cookie of cookies) expect(serialized).not.toContain(cookie)
    for (const [input, init] of transport.mock.calls) {
      const url = new URL(String(input))
      if (url.pathname === '/api/health') expect(new Headers(init?.headers).has('Cookie')).toBe(false)
      if (url.pathname === '/api/session' && init?.method === 'POST') expect(new Headers(init.headers).has('Cookie')).toBe(false)
    }
  })

  it('stops after a failed login without trying another key or domain', async () => {
    const { transport } = await fixtureTransport()
    const report = await runApiSmoke('MM-invalid-selected-key-abcdefghijklmnopqrstuvwxyz', { fetch: transport, pauseMs: 0 })
    expect(report).toMatchObject({ ready: false, stoppedReason: 'login_failed', rows: [] })
    expect(transport.mock.calls.filter(([, init]) => init?.method === 'POST')).toHaveLength(1)
    expect(transport.mock.calls.every(([input]) => String(input).startsWith(SMOKE_ORIGINS[0]))).toBe(true)
  })

  it('rejects a login redirect without following it or exposing the target in the report', async () => {
    const { transport } = await fixtureTransport(async (request, next) => request.method === 'POST'
      ? new Response(null, { status: 302, headers: { Location: `https://outside.invalid/${TEST_KEY}` } }) : next())
    const report = await runApiSmoke(TEST_KEY, { fetch: transport, pauseMs: 0 })
    expect(report.stoppedReason).toBe('redirect_rejected')
    expect(report.rows).toEqual([])
    expect(transport).toHaveBeenCalledTimes(3)
    expect(JSON.stringify(report)).not.toContain(TEST_KEY)
    expect(JSON.stringify(report)).not.toContain('outside.invalid')
  })

  it('stops before sending a key when an anonymous trip request returns data', async () => {
    const { transport } = await fixtureTransport(async (request, next) => new URL(request.url).pathname === '/api/trips'
      ? new Response(JSON.stringify(payload()), { headers: { 'Cache-Control': 'private, no-store' } }) : next())
    const report = await runApiSmoke(TEST_KEY, { fetch: transport, pauseMs: 0 })
    expect(report.stoppedReason).toBe('access_precheck_failed')
    expect(transport.mock.calls.some(([, init]) => init?.method === 'POST')).toBe(false)
  })

  it('reports unavailable schedules as failures and still clears both sessions', async () => {
    const { transport } = await fixtureTransport(undefined, true)
    const report = await runApiSmoke(TEST_KEY, { fetch: transport, pauseMs: 0 })
    expect(report.ready).toBe(false)
    expect(report.rows).toHaveLength(120)
    expect(report.rows.every((row) => row.state === 'failed' && row.status === 503 && !('trips' in row))).toBe(true)
    expect(report.rows.every((row) => !row.issues.includes('unsafe_cache'))).toBe(true)
    expect(report.rows.every((row) => row.cachePolicy === 'no-store')).toBe(true)
    expect(report.access.filter((check) => check.check === 'logout_and_cookie_clear' && check.ok)).toHaveLength(2)
    expect(JSON.stringify(report)).not.toContain(TEST_KEY)
  })

  it('sanitizes fetch exceptions and attempts logout after a failed authenticated request', async () => {
    const { transport } = await fixtureTransport(async (request, next) => {
      if (new URL(request.url).pathname === '/api/trips' && request.headers.has('Cookie')) throw new Error(TEST_KEY)
      return next()
    })
    const report = await runApiSmoke(TEST_KEY, { fetch: transport, pauseMs: 0 })
    expect(report.stoppedReason).toBe('request_failed')
    expect(report.access.some((check) => check.check === 'logout_and_cookie_clear' && check.ok)).toBe(true)
    expect(JSON.stringify(report)).not.toContain(TEST_KEY)
  })

  it('stops on a lost session instead of logging in again or continuing the matrix', async () => {
    const { transport } = await fixtureTransport(async (request, next) => new URL(request.url).pathname === '/api/trips' && request.headers.has('Cookie')
      ? new Response(JSON.stringify({ error: 'Session expired' }), { status: 401, headers: { 'Cache-Control': 'private, no-store' } }) : next())
    const report = await runApiSmoke(TEST_KEY, { fetch: transport, pauseMs: 0 })
    expect(report.stoppedReason).toBe('session_failed')
    expect(report.rows).toHaveLength(1)
    expect(report.rows[0]).toMatchObject({ status: 401, state: 'failed' })
    expect(transport.mock.calls.filter(([, init]) => init?.method === 'POST')).toHaveLength(1)
    expect(report.access.some((check) => check.check === 'logout_and_cookie_clear' && check.ok)).toBe(true)
  })

  it('refuses a domain-scoped session cookie and never sends it to a trip endpoint', async () => {
    const { transport } = await fixtureTransport(async (request, next) => {
      const response = await next()
      if (request.method === 'POST') response.headers.set('Set-Cookie', `${response.headers.get('Set-Cookie')}; Domain=.pages.dev`)
      return response
    })
    const report = await runApiSmoke(TEST_KEY, { fetch: transport, pauseMs: 0 })
    expect(report.stoppedReason).toBe('login_failed')
    expect(report.rows).toEqual([])
    expect(transport.mock.calls.some(([, init]) => new Headers(init?.headers).has('Cookie'))).toBe(false)
  })

  it.each([['invalid_json', '{not JSON'], ['response_too_large', 'x'.repeat(3 * 1024 * 1024 + 1)]])('stops safely for %s', async (reason, responseBody) => {
    const { transport } = await fixtureTransport(async (request, next) => new URL(request.url).pathname === '/api/trips' && request.headers.has('Cookie')
      ? new Response(responseBody, { headers: { 'Cache-Control': 'private, no-store' } }) : next())
    const report = await runApiSmoke(TEST_KEY, { fetch: transport, pauseMs: 0 })
    expect(report.stoppedReason).toBe(reason)
    expect(report.rows).toEqual([])
    expect(report.access.some((check) => check.check === 'logout_and_cookie_clear' && check.ok)).toBe(true)
    expect(JSON.stringify(report)).not.toContain(TEST_KEY)
  })

  it('builds a plan and rejects missing keys without any network call', async () => {
    expect(smokePlan(now)).toMatchObject({ startDate: today, endDate: '2026-12-13', expectedRows: 120 })
    const transport = vi.fn<typeof fetch>()
    await expect(runApiSmoke('', { fetch: transport })).rejects.toThrow('missing or invalid')
    expect(transport).not.toHaveBeenCalled()
  })
})

describe('smoke payload acceptance rules', () => {
  const cases: Array<[string, (body: TripsResponse) => void]> = [
    ['stale_price', (body) => { body.trips[0].bookingOptions[0].priceObservedAt = new Date(now.getTime() - 16 * 60000).toISOString() }],
    ['stale_seats', (body) => { body.trips[0].bookingOptions[0].availabilityObservedAt = new Date(now.getTime() - 16 * 60000).toISOString() }],
    ['expired_observation', (body) => { body.trips[0].bookingOptions[0].observedAt = new Date(now.getTime() - 8 * 86400000).toISOString() }],
    ['departed_trip', (body) => { body.trips[0].departureAt = `${today}T00:01:00+03:00` }],
    ['invalid_schema', (body) => { body.trips[0].bookingOptions[0].url = 'https://outside.invalid/' }],
    ['unconfirmed_empty', (body) => { body.trips = []; body.sources.forEach((source) => { source.coverage = [] }) }],
    ['missing_stale_flag', (body) => {
      body.trips[0].bookingOptions[0].observedAt = new Date(now.getTime() - 20 * 60000).toISOString()
      body.trips[0].price = null; body.trips[0].bookingOptions[0].price = null
      body.trips[0].availability = 'unknown'; body.trips[0].bookingOptions[0].availability = 'unknown'
      body.trips[0].seats = undefined; body.trips[0].bookingOptions[0].seats = undefined
    }],
  ]
  it.each(cases)('rejects %s', (issue, change) => {
    const body = payload(); change(body)
    const row = auditSmokePayload(SMOKE_ORIGINS[0], 'mogilev-minsk', today, 200, 'private, no-store', body, now)
    expect(row.state).toBe('failed')
    expect(row.issues).toContain(issue)
  })

  it('accepts confirmed emptiness and unknown values without inventing fares, seats or durations', () => {
    const body = payload()
    body.trips[0].price = null; body.trips[0].bookingOptions[0].price = null
    body.trips[0].availability = 'unknown'; body.trips[0].bookingOptions[0].availability = 'unknown'
    body.trips[0].seats = undefined; body.trips[0].bookingOptions[0].seats = undefined
    body.trips[0].durationMinutes = null; body.trips[0].arrivalAt = null
    expect(auditSmokePayload(SMOKE_ORIGINS[0], 'mogilev-minsk', today, 200, 'private, no-store', body, now))
      .toMatchObject({ state: 'ok', unknownPrices: 1, unknownSeats: 1, unknownDurations: 1 })
    body.trips = []
    expect(auditSmokePayload(SMOKE_ORIGINS[0], 'mogilev-minsk', today, 200, 'private, no-store', body, now))
      .toMatchObject({ state: 'ok', trips: 0 })
  })

  it('separates partial/backup data from acceptance and rejects public caching', () => {
    const body = { ...payload(), stale: true, partial: true, usedBackup: true }
    expect(auditSmokePayload(SMOKE_ORIGINS[0], 'mogilev-minsk', today, 200, 'private, no-store', body, now))
      .toMatchObject({ state: 'degraded', issues: expect.arrayContaining(['stale_data', 'partial_data', 'backup_data']) })
    expect(auditSmokePayload(SMOKE_ORIGINS[0], 'mogilev-minsk', today, 200, 'public, max-age=60', payload(), now))
      .toMatchObject({ state: 'failed', issues: ['unsafe_cache'] })
    expect(auditSmokePayload(SMOKE_ORIGINS[0], 'mogilev-minsk', today, 200, 'no-store', payload(), now))
      .toMatchObject({ state: 'ok', cachePolicy: 'no-store', issues: [] })
  })
})
