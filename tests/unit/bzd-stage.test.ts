import { afterEach, describe, expect, it, vi } from 'vitest'
import { bzdBatches, bzdBatchPairs, bzdStageKey, BZD_SOURCE, combineBzdStages, createBzdStage, isBzdStage, saveBzdStage, type BzdBatch } from '../../scripts/lib/bzd-stage'
import { collectBzdBatches } from '../../scripts/lib/bzd-collection'
import { buildSnapshots } from '../../scripts/lib/snapshots'
import { projectTrip } from '../../src/lib/trips'
import type { SourceResult } from '../../scripts/lib/source'
import { fixtureTrip } from '../fixtures/schedule'

const now = new Date('2026-10-14T09:10:00Z')
const batch = bzdBatches('near', '2026-10-14')[0]
const pairs = bzdBatchPairs(batch)
function result(descriptor = batch, time = now, empty = false, failed = false): SourceResult {
  const requested = bzdBatchPairs(descriptor)
  return { health: { ...BZD_SOURCE, checkedAt: time.toISOString(), status: failed ? 'error' : 'ok',
    coverage: requested.map((pair) => ({ ...pair, checkedAt: time.toISOString(), status: failed ? 'error' : 'ok' })) },
  trips: empty || failed ? [] : requested.map(({ direction, date }) => {
    const trip = fixtureTrip(date, direction, time)
    return { ...trip, id: `bzd:${direction}:${date}`, vehicleType: 'train', bookingOptions: trip.bookingOptions.map((option) => ({
      ...option, sourceId: 'bzd', sourceName: 'БЖД', url: `https://pass.rw.by/ru/route/?date=${date}`,
    })) }
  }) }
}

afterEach(() => { vi.unstubAllGlobals(); vi.unstubAllEnvs() })
describe('independent BZD packages retain actual observations', () => {
  it('covers 30 dates exactly once, with two directions and at most five far dates', () => {
    const batches = [batch, ...bzdBatches('far', batch.anchorDate)]
    expect(new Set(batches.map(bzdStageKey)).size).toBe(7)
    const all = batches.flatMap(bzdBatchPairs)
    expect(all).toHaveLength(60)
    expect(new Set(all.map((pair) => `${pair.direction}/${pair.date}`)).size).toBe(60)
    expect(bzdBatchPairs(batches.at(-1)!)).toHaveLength(4)
    expect(() => bzdBatchPairs({ ...batch, part: 1 })).toThrow()
  })

  it('chooses observation time rather than the later publication time of another package', () => {
    const earlier = new Date('2026-10-14T09:00:00Z')
    const overlapping: BzdBatch = { scope: 'far', part: 0, anchorDate: '2026-10-12' }
    const newerPackage = createBzdStage(overlapping, result(overlapping, earlier), undefined, now)
    const newerObservation = createBzdStage(batch, result(batch, now, true), undefined, now)
    expect(combineBzdStages([newerPackage, newerObservation], pairs, now).trips).toHaveLength(0)
  })

  it('preserves timestamps after failure and does not restore trips after a confirmed empty result', () => {
    const earlier = new Date('2026-10-14T09:00:00Z')
    const old = createBzdStage(batch, result(batch, earlier), undefined, earlier)
    const failure = createBzdStage(batch, result(batch, now, false, true), old, now)
    expect(failure.result.trips).toHaveLength(4) // The first date has already departed.
    const combined = combineBzdStages([failure], pairs, now)
    expect(combined.trips[0].bookingOptions[0]).toMatchObject({ observedAt: earlier.toISOString(), lastKnown: true })
    expect(projectTrip(combined.trips[0], now)).toMatchObject({ price: null, availability: 'unknown' })
    const empty = createBzdStage(batch, result(batch, earlier, true), old, earlier)
    const failedAfterEmpty = createBzdStage(batch, result(batch, now, false, true), empty, now)
    expect(combineBzdStages([old, failedAfterEmpty], pairs, now).trips).toHaveLength(0)
    const priorSnapshots = buildSnapshots([old.result], {}, earlier).snapshots
    const publishedAfterFailure = buildSnapshots([combineBzdStages([failedAfterEmpty], pairs, now)],
      Object.fromEntries(priorSnapshots.map((snapshot) => [snapshot.direction, snapshot])), now)
    expect(publishedAfterFailure.snapshots.flatMap((snapshot) => snapshot.trips)).toHaveLength(0)

    // A newer empty confirmation in a different overlapping package also wins.
    const overlapping: BzdBatch = { scope: 'far', part: 0, anchorDate: '2026-10-12' }
    const nonempty = createBzdStage(overlapping, result(overlapping, new Date('2026-10-14T08:50:00Z')), undefined, earlier)
    expect(combineBzdStages([nonempty, failedAfterEmpty], pairs, now).trips).toHaveLength(0)
  })

  it('rejects corrupt, wrong-source, wrong-date and future-observation packages without refreshing old data', () => {
    const good = createBzdStage(batch, result(), undefined, now)
    for (const mutate of [
      (stage: typeof good) => { stage.result.trips[0].bookingOptions[0].sourceId = 'atlas' },
      (stage: typeof good) => { stage.result.trips[0].bookingOptions[0].url = 'https://untrusted.test/' },
      (stage: typeof good) => { stage.result.health.coverage![0].date = '2026-10-25' },
      (stage: typeof good) => { stage.result.trips[0].bookingOptions[0].observedAt = '2027-01-01T00:00:00Z' },
      (stage: typeof good) => { stage.confirmedCoverage = [] },
    ]) {
      const corrupt = structuredClone(good); mutate(corrupt)
      expect(isBzdStage(corrupt, now)).toBe(false)
      expect(combineBzdStages([corrupt], pairs, now).health.status).toBe('error')
    }
    const weekLater = new Date(now.getTime() + 8 * 86400000)
    expect(combineBzdStages([good], pairs, weekLater).trips).toHaveLength(0)
    const published = buildSnapshots([combineBzdStages([good], pairs, now)], {}, now)
    expect(published.snapshots.flatMap((snapshot) => snapshot.trips)[0].lastSeenAt).toBe(now.toISOString())
  })

  it('writes only one staging key, validates its readback and never changes manifest', async () => {
    vi.stubEnv('CLOUDFLARE_ACCOUNT_ID', 'a'.repeat(32)); vi.stubEnv('KV_NAMESPACE_ID', 'b'.repeat(32)); vi.stubEnv('CLOUDFLARE_API_TOKEN', 'test-only-token')
    const stage = createBzdStage(batch, result(), undefined, now)
    const writes: Array<{ key: string; value: string; expiration_ttl: number }> = []
    vi.stubGlobal('fetch', vi.fn(async (_url: string, init: RequestInit) => {
      if (init.method === 'PUT') { writes.push(...JSON.parse(String(init.body))); return new Response('{"success":true}') }
      return new Response(writes[0].value)
    }))
    await saveBzdStage(stage)
    expect(writes.map((entry) => entry.key)).toEqual(['source:bzd:near'])
    expect(writes[0].expiration_ttl).toBe(7 * 86400)
    expect(writes[0].value).not.toContain('manifest:active')
    vi.stubGlobal('fetch', vi.fn(async (_url: string, init: RequestInit) => new Response(init.method === 'PUT' ? '{"success":true}' : '{}')))
    await expect(saveBzdStage(stage, async () => {})).rejects.toThrow('не подтверждена')
  })

  it('waits for a stale KV read without repeating the write or refreshing observations', async () => {
    vi.stubEnv('CLOUDFLARE_ACCOUNT_ID', 'a'.repeat(32)); vi.stubEnv('KV_NAMESPACE_ID', 'b'.repeat(32)); vi.stubEnv('CLOUDFLARE_API_TOKEN', 'test-only-token')
    const stage = createBzdStage(batch, result(), undefined, now)
    const stale = createBzdStage(batch, result(batch, new Date('2026-10-14T09:00:00Z')), undefined, now)
    let reads = 0, writes = 0
    const pause = vi.fn(async () => {})
    vi.stubGlobal('fetch', vi.fn(async (_url: string, init: RequestInit) => {
      if (init.method === 'PUT') { writes++; return Response.json({ success: true }) }
      reads++
      return Response.json(reads < 3 ? stale : stage)
    }))
    await saveBzdStage(stage, pause)
    expect(writes).toBe(1); expect(reads).toBe(3); expect(pause).toHaveBeenCalledTimes(2)
    expect(stage.result.trips[0].bookingOptions[0].observedAt).toBe(now.toISOString())
  })

  it('compares JSON contents independently of object property order', async () => {
    vi.stubEnv('CLOUDFLARE_ACCOUNT_ID', 'a'.repeat(32)); vi.stubEnv('KV_NAMESPACE_ID', 'b'.repeat(32)); vi.stubEnv('CLOUDFLARE_API_TOKEN', 'test-only-token')
    const stage = createBzdStage(batch, result(), undefined, now)
    const reordered = Object.fromEntries(Object.entries(JSON.parse(JSON.stringify(stage))).reverse())
    const pause = vi.fn(async () => {})
    vi.stubGlobal('fetch', vi.fn(async (_url: string, init: RequestInit) => Response.json(init.method === 'PUT' ? { success: true } : reordered)))
    await saveBzdStage(stage, pause)
    expect(pause).not.toHaveBeenCalled()
  })
})

describe('far producer persists each package before requesting the next', () => {
  it('uses one request slot and saves six packages in order', async () => {
    const events: string[] = []
    const collect = vi.fn(async (_days, requested, concurrency) => {
      expect(concurrency).toBe(1)
      const part = Math.floor((Date.parse(requested![0].date) - Date.parse('2026-10-17')) / (5 * 86400000))
      events.push(`collect${part}`)
      return result(bzdBatches('far', '2026-10-14')[part])
    })
    expect(await collectBzdBatches('far', { collect, now: () => now,
      read: async (descriptor) => { events.push(`read${descriptor.part}`); return undefined },
      write: async (stage) => { events.push(`write${stage.part}`) },
    })).toBe(true)
    expect(events).toEqual(Array.from({ length: 6 }, (_, part) => [`read${part}`, `collect${part}`, `write${part}`]).flat())
  })

  it('does not resume requests in later packages after a block or exhausted cycle', async () => {
    const writes: string[] = []
    const collect = vi.fn(async () => ({ ...result(bzdBatches('far', '2026-10-14')[0], now, false, true), halted: true }))
    expect(await collectBzdBatches('far', { collect, now: () => now, read: async () => undefined,
      write: async (stage) => { writes.push(bzdStageKey(stage)); expect(stage.result.health.status).toBe('error') },
    })).toBe(false)
    expect(collect).toHaveBeenCalledTimes(1)
    expect(writes).toHaveLength(6)
  })

  it('stops if a package cannot be saved, leaving earlier packages durable', async () => {
    let saved = 0
    const collect = vi.fn(async (_days, requested) => result(bzdBatches('far', '2026-10-14').find((descriptor) => bzdBatchPairs(descriptor)[0].date === requested![0].date)!))
    await expect(collectBzdBatches('far', { collect, now: () => now, read: async () => undefined,
      write: async () => { if (saved === 1) throw new Error('KV unavailable'); saved++ },
    })).rejects.toThrow('KV unavailable')
    expect(saved).toBe(1)
    expect(collect).toHaveBeenCalledTimes(2)
  })
})
