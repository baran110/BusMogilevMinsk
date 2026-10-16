import { afterEach, describe, expect, it, vi } from 'vitest'
import { publishSnapshots, validatePublication } from '../../scripts/lib/kv'
import { buildSnapshots } from '../../scripts/lib/snapshots'
import { fixtureTrip } from '../fixtures/schedule'
import { HttpError, fetchWithTimeout } from '../../scripts/lib/fetch'
import type { DirectionSnapshot, SourceHealth } from '../../src/types'

afterEach(() => { vi.unstubAllGlobals(); vi.unstubAllEnvs() })
const now = new Date('2026-10-14T09:00:00Z')
const source: SourceHealth = { id: 'avtoslava', name: 'АвтоСлава', kind: 'carrier', url: 'https://avto-slava.by/', status: 'ok',
  checkedAt: now.toISOString(), coverage: [{ direction: 'mogilev-minsk', date: '2026-10-15', status: 'ok', checkedAt: now.toISOString() }] }
function candidate() { return buildSnapshots([{ health: source, trips: [fixtureTrip('2026-10-15', 'mogilev-minsk', now)] }], {}, now, 'near') }
describe('safe KV publication', () => {
  it('rejects all-source failures, unsafe booking links, oversized or missing snapshots', () => {
    const { manifest, snapshots } = candidate()
    expect(() => validatePublication(manifest, snapshots, { snapshots: {} }, now)).not.toThrow()
    expect(() => validatePublication({ ...manifest, sources: [{ ...source, coverage: [], status: 'error' }] }, snapshots, { snapshots: {} }, now)).toThrow('Ни один')
    expect(() => validatePublication(manifest, snapshots.slice(0, 1), { snapshots: {} }, now)).toThrow()
    snapshots[0].trips[0].bookingOptions[0].url = 'https://untrusted.test/'
    expect(() => validatePublication(manifest, snapshots, { snapshots: {} }, now)).toThrow()
  })
  it('compares only future trips on comparable dates before a 60% drop', () => {
    const { manifest, snapshots } = candidate()
    const previous: DirectionSnapshot = { ...snapshots[0], trips: Array.from({ length: 10 }, (_, i) => ({ ...snapshots[0].trips[0], id: String(i) })) }
    expect(() => validatePublication(manifest, snapshots, { snapshots: { 'mogilev-minsk': previous } }, now)).toThrow('60%')
    previous.trips.forEach((trip) => { trip.serviceDate = '2026-10-20' })
    expect(() => validatePublication(manifest, snapshots, { snapshots: { 'mogilev-minsk': previous } }, now)).not.toThrow()
  })
  it('never changes manifest if Cloudflare returns success:false or a candidate is missing', async () => {
    vi.stubEnv('CLOUDFLARE_ACCOUNT_ID', 'a'.repeat(32)); vi.stubEnv('KV_NAMESPACE_ID', 'b'.repeat(32)); vi.stubEnv('CLOUDFLARE_API_TOKEN', 'test-token')
    const { manifest, snapshots } = candidate()
    const writes: string[] = []
    vi.stubGlobal('fetch', vi.fn(async (url: string, init: RequestInit) => {
      if (init.method === 'PUT') { writes.push(url); return new Response('{"success":false}') }
      return new Response('{}', { status: 404 })
    }))
    await expect(publishSnapshots(manifest, snapshots, { snapshots: {} }, now)).rejects.toThrow('не подтвердил')
    expect(writes).toHaveLength(1)
    expect(writes[0]).toContain('/bulk')
  })
})
describe('bounded external requests', () => {
  it('does not retry a block or an unspecified rate limit', async () => {
    for (const status of [403, 404, 429]) {
      const fetcher = vi.fn(async () => new Response('blocked', { status }))
      vi.stubGlobal('fetch', fetcher)
      await expect(fetchWithTimeout('https://source.test')).rejects.toBeInstanceOf(HttpError)
      expect(fetcher).toHaveBeenCalledTimes(1)
    }
  })
  it('preserves caller cancellation and rejects excessive response bodies', async () => {
    const controller = new AbortController(); controller.abort(new Error('cancelled'))
    await expect(fetchWithTimeout('https://source.test', { signal: controller.signal })).rejects.toThrow('cancelled')
    vi.stubGlobal('fetch', vi.fn(async () => new Response('x', { headers: { 'Content-Length': '9000000' } })))
    await expect(fetchWithTimeout('https://source.test')).rejects.toThrow('слишком большой')
  })
})
