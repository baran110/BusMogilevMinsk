import { describe, expect, it } from 'vitest'
import { handleHealthRequest } from '../../functions/api/_health'
import { fixtureKv } from '../fixtures/schedule'
import type { SnapshotManifest } from '../../src/types'
import { addDays } from '../../src/lib/date'

const now = new Date('2026-10-14T09:00:00Z')
const date = '2026-10-15'
describe('public monitoring contains no private schedules or credentials', () => {
  it('tolerates one failed cycle after a complete success and alerts on the second', async () => {
    const base = fixtureKv(date, now)
    const manifest = (await base.get<SnapshotManifest>('manifest:active', 'json'))!
    for (const failures of [1, 2]) {
      const modified = { ...manifest, sources: manifest.sources.map((source) => ({ ...source, status: 'error', failureStreak: failures,
        lastCompleteSuccessAt: new Date(now.getTime() - 10 * 60000).toISOString(), coverage: [] })) }
      const response = await handleHealthRequest(new Request('https://site.test/api/health?source=avtoslava'), fixtureKv(date, now, new Map([['manifest:active', modified]])), now)
      expect(response.status).toBe(failures === 1 ? 200 : 503)
    }
  })
  it('detects missing storage, stale cycles and missing direction snapshots', async () => {
    const request = new Request('https://site.test/api/health')
    expect((await handleHealthRequest(request, { get: async () => null }, now)).status).toBe(503)
    expect((await handleHealthRequest(request, fixtureKv(date, now), now)).status).toBe(200)
    const response = await handleHealthRequest(request, fixtureKv(date, new Date(now.getTime() - 21 * 60000)), now)
    expect(response.status).toBe(503)
    expect(await response.json()).toMatchObject({ reason: 'collector_delayed' })
    const manifest = await fixtureKv(date, now).get<SnapshotManifest>('manifest:active', 'json')
    expect((await handleHealthRequest(request, fixtureKv(date, now, new Map([['manifest:active', manifest]])), now)).status).toBe(503)
  })
  it('does not return trips or grant information and separates source alarms', async () => {
    const response = await handleHealthRequest(new Request('https://site.test/api/health'), fixtureKv(date, now), now)
    const text = await response.text()
    expect(text).not.toContain('bookingOptions')
    expect(text).not.toContain('SESSION_SECRET')
    expect((await handleHealthRequest(new Request('https://site.test/api/health?source=avtoslava'), fixtureKv(date, now), now)).status).toBe(503)
  })

  it('checks far BZD dates independently: fresh near data cannot hide an old or missing far date', async () => {
    const manifest = (await fixtureKv(date, now).get<SnapshotManifest>('manifest:active', 'json'))!
    for (const delayed of [false, true]) {
      const bzd = { ...manifest.sources[0], id: 'bzd', name: 'БЖД', url: 'https://pass.rw.by/ru/', failureStreak: 1, lastCompleteSuccessAt: now.toISOString(),
        coverage: Array.from({ length: 30 }, (_, day) => (['mogilev-minsk', 'minsk-mogilev'] as const).map((direction) => ({
          direction, date: addDays('2026-10-14', day), status: 'ok' as const,
          checkedAt: new Date(now.getTime() - (day === 29 && delayed ? 76 : day >= 3 ? 60 : 0) * 60000).toISOString(),
        }))).flat() }
      const storage = fixtureKv(date, now, new Map([['manifest:active', { ...manifest, sources: [bzd] }]]))
      expect((await handleHealthRequest(new Request('https://site.test/api/health?source=bzd'), storage, now)).status).toBe(200)
      const far = await handleHealthRequest(new Request('https://site.test/api/health?source=bzd&check=full'), storage, now)
      expect(far.status).toBe(delayed ? 503 : 200)
      expect(await far.json()).toMatchObject({ scope: 'far', source: 'bzd' })
      bzd.coverage.pop()
      expect((await handleHealthRequest(new Request('https://site.test/api/health?source=bzd&check=full'), storage, now)).status).toBe(503)
    }
  })
})
