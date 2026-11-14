import registry from '../../data/sources.json'
import { addDays, isDeparted, localDate } from '../../src/lib/date'
import { DIRECTIONS, isTripsResponse } from '../../src/lib/validation'
import { chooseBestBooking, FIELD_MAX_AGE_MS, observationAge, SCHEDULE_MAX_AGE_MS } from '../../src/lib/trips'
import type { Direction } from '../../src/types'

// Credentials must never be sent to a caller-supplied URL or a redirect target.
export const SMOKE_ORIGINS = ['https://bus-mogilev-minsk.pages.dev', 'https://mm-routes-mirror.vojtenkoa695.workers.dev'] as const
const connectedSources = registry.filter((source) => source.enabled && !['link-only', 'availability'].includes(source.adapter))
type Issue = 'http_error' | 'invalid_schema' | 'unsafe_cache' | 'expired_observation' | 'stale_price' | 'stale_seats'
  | 'departed_trip' | 'booking_mismatch' | 'duration_mismatch' | 'unconfirmed_empty' | 'missing_stale_flag'
  | 'partial_data' | 'backup_data' | 'stale_data' | 'coverage_incomplete'
type StopReason = 'request_failed' | 'redirect_rejected' | 'response_too_large' | 'invalid_json'
  | 'access_precheck_failed' | 'login_failed' | 'session_failed' | 'date_boundary_crossed'
export interface SmokeRow {
  origin: string; direction: Direction; date: string; status: number
  cachePolicy: 'private-no-store' | 'no-store' | 'unsafe'
  state: 'ok' | 'degraded' | 'failed'; issues: Issue[]
  trips?: number; unknownPrices?: number; unknownSeats?: number; unknownDurations?: number
  maxObservationAgeMinutes?: number | null; confirmedSources?: number
  sourceCoverage?: Array<{ source: string; fresh: boolean; ageMinutes: number | null }>
  stale?: boolean; partial?: boolean; usedBackup?: boolean
}
interface AccessCheck { origin: string; check: string; status: number; ok: boolean }
export interface SmokeReport {
  origins: string[]
  startedAt: string; finishedAt: string; startDate: string; endDate: string; expectedRows: number
  ready: boolean; stoppedReason?: StopReason
  access: AccessCheck[]; health: Array<{ origin: string; check: string; status: number; healthy: boolean }>; rows: SmokeRow[]
}

export function smokePlan(now = new Date()) {
  const startDate = localDate(now)
  return { origins: [...SMOKE_ORIGINS], startDate, endDate: addDays(startDate, 29), expectedRows: 120 }
}

function cachePolicy(value: string | null): SmokeRow['cachePolicy'] {
  const directives = (value ?? '').toLowerCase().split(',').map((item) => item.trim())
  if (!directives.includes('no-store') || directives.includes('public')) return 'unsafe'
  return directives.includes('private') ? 'private-no-store' : 'no-store'
}

/** Only numeric/boolean summaries and fixed issue codes leave this boundary. */
export function auditSmokePayload(origin: string, direction: Direction, date: string, status: number,
  cacheControl: string | null, body: unknown, now = new Date()): SmokeRow {
  const issues = new Set<Issue>()
  const row: SmokeRow = { origin, direction, date, status, cachePolicy: cachePolicy(cacheControl), state: 'failed', issues: [] }
  if (row.cachePolicy === 'unsafe') issues.add('unsafe_cache')
  if (status !== 200) issues.add('http_error')
  else if (!isTripsResponse(body, direction, date)
    || (body.partial !== undefined && typeof body.partial !== 'boolean')
    || (body.usedBackup !== undefined && typeof body.usedBackup !== 'boolean')) issues.add('invalid_schema')
  else {
    row.trips = body.trips.length
    row.stale = body.stale; row.partial = !!body.partial; row.usedBackup = !!body.usedBackup
    row.unknownPrices = body.trips.filter((trip) => trip.price === null).length
    row.unknownSeats = body.trips.filter((trip) => trip.seats === undefined).length
    row.unknownDurations = body.trips.filter((trip) => trip.durationMinutes === null).length
    const dateMaxAge = date < addDays(localDate(now), 3) ? FIELD_MAX_AGE_MS : 75 * 60000
    let oldestAge = -Infinity
    for (const trip of body.trips) {
      if (isDeparted(trip.departureAt, now)) issues.add('departed_trip')
      if (trip.durationMinutes !== null && trip.arrivalAt !== null
        && (Date.parse(trip.arrivalAt) - Date.parse(trip.departureAt)) / 60000 !== trip.durationMinutes) issues.add('duration_mismatch')
      for (const option of trip.bookingOptions) {
        const age = observationAge(option.observedAt ?? trip.lastSeenAt, now)
        oldestAge = Math.max(oldestAge, age)
        if (age > SCHEDULE_MAX_AGE_MS) issues.add('expired_observation')
        if (age > dateMaxAge && !option.lastKnown) issues.add('missing_stale_flag')
        if (option.price !== null && (option.lastKnown || observationAge(option.priceObservedAt, now) > FIELD_MAX_AGE_MS)) issues.add('stale_price')
        if ((option.availability !== 'unknown' || option.seats !== undefined)
          && (option.lastKnown || observationAge(option.availabilityObservedAt, now) > FIELD_MAX_AGE_MS)) issues.add('stale_seats')
      }
      const best = chooseBestBooking(trip.bookingOptions)
      if (trip.price !== best.price || trip.availability !== best.availability || trip.seats !== best.seats) issues.add('booking_mismatch')
      if (trip.bookingOptions.every((option) => option.lastKnown) && !trip.lastKnown) issues.add('missing_stale_flag')
    }
    row.maxObservationAgeMinutes = Number.isFinite(oldestAge) ? Math.floor(oldestAge / 60000) : null
    row.sourceCoverage = connectedSources.map((expected) => {
      const observations = body.sources.find((source) => source.id === expected.id)?.coverage
        ?.filter((item) => item.direction === direction && item.date === date) ?? []
      const latest = observations.sort((a, b) => Date.parse(b.checkedAt) - Date.parse(a.checkedAt))[0]
      const age = observationAge(latest?.checkedAt, now)
      return { source: expected.id, fresh: latest?.status === 'ok' && age <= dateMaxAge,
        ageMinutes: Number.isFinite(age) ? Math.floor(age / 60000) : null }
    })
    row.confirmedSources = row.sourceCoverage.filter((source) => source.fresh).length
    if (!body.trips.length && !row.confirmedSources) issues.add('unconfirmed_empty')
    if (row.confirmedSources < connectedSources.length) issues.add('coverage_incomplete')
    if (!body.stale && (body.usedBackup || observationAge(body.generatedAt, now) > 20 * 60000 || body.trips.some((trip) => trip.lastKnown))) issues.add('missing_stale_flag')
    if (body.stale) issues.add('stale_data')
    if (body.partial) issues.add('partial_data')
    if (body.usedBackup) issues.add('backup_data')
  }
  row.issues = [...issues]
  const warnings: Issue[] = ['partial_data', 'backup_data', 'stale_data', 'coverage_incomplete']
  row.state = row.issues.some((issue) => !warnings.includes(issue)) ? 'failed' : row.issues.length ? 'degraded' : 'ok'
  return row
}

class SmokeRequestError extends Error {
  constructor(readonly code: StopReason) { super(code) }
}
interface Reply { status: number; cacheControl: string | null; cookie: string | null; body: unknown }

function sessionCookie(header: string | null, logout = false): string | undefined {
  if (!header) return undefined
  const parts = header.split(';').map((part) => part.trim())
  const value = parts[0].match(/^__Host-mm-session=([A-Za-z0-9_.-]*)$/)?.[1]
  const attributes = parts.slice(1).map((part) => part.toLowerCase())
  if (value === undefined || !attributes.includes('path=/') || !attributes.includes('secure') || !attributes.includes('httponly')
    || !attributes.includes('samesite=lax') || !attributes.includes(`max-age=${logout ? 0 : 604800}`)
    || attributes.some((part) => part.startsWith('domain=')) || (logout ? value !== '' : !/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/.test(value))) return undefined
  return parts[0]
}

/** No KV writes or key mutations. POST/DELETE only create/clear this run's session. */
export async function runApiSmoke(key: string, options: { fetch?: typeof fetch; now?: () => Date; pauseMs?: number } = {}): Promise<SmokeReport> {
  if (!/^MM-[A-Za-z0-9_-]{29,125}$/.test(key)) throw new Error('Selected access key is missing or invalid')
  const clock = options.now ?? (() => new Date())
  const started = clock()
  const plan = smokePlan(started)
  const report: SmokeReport = { ...plan, startedAt: started.toISOString(), finishedAt: started.toISOString(),
    ready: false, access: [], health: [], rows: [] }
  const send = options.fetch ?? fetch
  async function request(origin: string, path: string, method = 'GET', cookie?: string, login = false): Promise<Reply> {
    if (!(SMOKE_ORIGINS as readonly string[]).includes(origin) || !path.startsWith('/api/')) throw new SmokeRequestError('request_failed')
    const headers: Record<string, string> = { Accept: 'application/json' }
    if (cookie) headers.Cookie = cookie
    if (method !== 'GET') headers.Origin = origin
    if (login) headers['Content-Type'] = 'application/json'
    let response: Response | undefined
    let reader: ReadableStreamDefaultReader<Uint8Array> | undefined
    try {
      response = await send(`${origin}${path}`, { method, headers, body: login ? JSON.stringify({ key }) : undefined,
        redirect: 'manual', credentials: 'omit', cache: 'no-store', signal: AbortSignal.timeout(20_000) })
      if (response.status >= 300 && response.status < 400) throw new SmokeRequestError('redirect_rejected')
      reader = response.body?.getReader()
      const chunks: Uint8Array[] = []
      let bytes = 0
      if (reader) while (true) {
        const item = await reader.read()
        if (item.done) break
        bytes += item.value.byteLength
        if (bytes > 3 * 1024 * 1024) throw new SmokeRequestError('response_too_large')
        chunks.push(item.value)
      }
      let body: unknown
      try { body = JSON.parse(Buffer.concat(chunks).toString('utf8')) }
      catch { throw new SmokeRequestError('invalid_json') }
      return { status: response.status, cacheControl: response.headers.get('Cache-Control'),
        cookie: response.headers.get('Set-Cookie'), body }
    } catch (error) {
      throw error instanceof SmokeRequestError ? error : new SmokeRequestError('request_failed')
    } finally {
      if (reader) { await reader.cancel().catch(() => undefined); reader.releaseLock() }
      else await response?.body?.cancel().catch(() => undefined)
    }
  }
  const tripPath = (direction: Direction, date: string) => `/api/trips?${new URLSearchParams({ direction, date })}`
  const access = (origin: string, check: string, response: Reply, expected: number, additional = true) => {
    const ok = response.status === expected && cachePolicy(response.cacheControl) !== 'unsafe' && additional
    report.access.push({ origin, check, status: response.status, ok })
    return ok
  }
  try {
    for (const origin of SMOKE_ORIGINS) {
      let cookie: string | undefined
      try {
        const anonymous = await request(origin, tripPath('mogilev-minsk', plan.startDate))
        const anonymousSession = await request(origin, '/api/session')
        if (!access(origin, 'anonymous_trips', anonymous, 401) || !access(origin, 'anonymous_session', anonymousSession, 401)) {
          report.stoppedReason = 'access_precheck_failed'; break
        }
        const login = await request(origin, '/api/session', 'POST', undefined, true)
        cookie = sessionCookie(login.cookie)
        if (!access(origin, 'login_and_cookie_attributes', login, 200, !!cookie)) { report.stoppedReason = 'login_failed'; break }
        const session = await request(origin, '/api/session', 'GET', cookie)
        const authenticated = !!session.body && typeof session.body === 'object' && 'authenticated' in session.body && session.body.authenticated === true
        if (!access(origin, 'authenticated_session', session, 200, authenticated)) { report.stoppedReason = 'session_failed'; break }
        for (const [check, query] of [['near', ''], ['far', '?check=full'], ['bzd_near', '?source=bzd'], ['bzd_far', '?source=bzd&check=full']]) {
          const health = await request(origin, `/api/health${query}`)
          report.health.push({ origin, check, status: health.status, healthy: health.status === 200
            && !!health.body && typeof health.body === 'object' && 'healthy' in health.body && health.body.healthy === true })
        }
        for (let day = 0; day < 30; day++) {
          if (localDate(clock()) !== plan.startDate) { report.stoppedReason = 'date_boundary_crossed'; break }
          const date = addDays(plan.startDate, day)
          for (const direction of DIRECTIONS) {
            const response = await request(origin, tripPath(direction, date), 'GET', cookie)
            report.rows.push(auditSmokePayload(origin, direction, date, response.status,
              response.cacheControl, response.body, clock()))
            if (response.status === 401) { report.stoppedReason = 'session_failed'; break }
            const pause = options.pauseMs ?? 100
            if (pause > 0) await new Promise<void>((resolve) => setTimeout(resolve, pause))
          }
          if (report.stoppedReason) break
        }
      } finally {
        if (cookie) {
          // This clears only our cookie, not the access key or other sessions.
          const logout = await request(origin, '/api/session', 'DELETE', cookie)
          access(origin, 'logout_and_cookie_clear', logout, 200, sessionCookie(logout.cookie, true) !== undefined)
          cookie = undefined
          access(origin, 'logged_out_session', await request(origin, '/api/session'), 401)
          access(origin, 'logged_out_trips', await request(origin, tripPath('mogilev-minsk', plan.startDate)), 401)
        }
      }
      if (report.stoppedReason) break
    }
  } catch (error) { report.stoppedReason ??= error instanceof SmokeRequestError ? error.code : 'request_failed' }
  report.finishedAt = clock().toISOString()
  report.ready = !report.stoppedReason && report.rows.length === plan.expectedRows && report.rows.every((row) => row.state === 'ok')
    && report.access.length === 14 && report.access.every((check) => check.ok) && report.health.length === 8 && report.health.every((check) => check.healthy)
  return report
}
