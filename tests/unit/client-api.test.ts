import { afterEach, describe, expect, it, vi } from 'vitest'
import { ApiError, fetchTrips } from '../../src/lib/api'
import { fixtureTrip } from '../fixtures/schedule'

afterEach(() => vi.unstubAllGlobals())
describe('client never substitutes test schedules', () => {
  it('rejects API failures, network errors, invalid JSON and wrong-direction payloads', async () => {
    for (const response of [new Response('{}', { status: 503 }), new Response('<html>'), new Response(JSON.stringify({ trips: [fixtureTrip('2026-10-15', 'minsk-mogilev')] }))]) {
      vi.stubGlobal('fetch', vi.fn(async () => response))
      await expect(fetchTrips('mogilev-minsk', '2026-10-15')).rejects.toBeInstanceOf(ApiError)
    }
    vi.stubGlobal('fetch', vi.fn(async () => { throw new TypeError('offline') }))
    await expect(fetchTrips('mogilev-minsk', '2026-10-15')).rejects.toBeInstanceOf(ApiError)
  })
  it('propagates aborts and identifies expired sessions', async () => {
    const controller = new AbortController()
    controller.abort()
    vi.stubGlobal('fetch', vi.fn(async () => { throw new DOMException('Aborted', 'AbortError') }))
    await expect(fetchTrips('mogilev-minsk', '2026-10-15', controller.signal)).rejects.toMatchObject({ name: 'AbortError' })
    vi.stubGlobal('fetch', vi.fn(async () => new Response('{}', { status: 401 })))
    await expect(fetchTrips('mogilev-minsk', '2026-10-15')).rejects.toMatchObject({ status: 401 })
  })
})
