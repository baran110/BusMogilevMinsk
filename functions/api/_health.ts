import type { KvReader } from './_service'
import type { SnapshotManifest } from '../../src/types'
import { isManifest } from '../../src/lib/validation'
import { addDays, localDate } from '../../src/lib/date'
import { observationAge } from '../../src/lib/trips'
import { json } from './_auth'

export async function handleHealthRequest(request: Request, kv: KvReader, now = new Date()): Promise<Response> {
  if (request.method !== 'GET') return json({ error: 'Метод не поддерживается' }, 405, { Allow: 'GET' })
  try {
    const manifest = await kv.get<SnapshotManifest>('manifest:active', 'json')
    if (!isManifest(manifest)) return json({ healthy: false, reason: 'missing_or_invalid_manifest' }, 503)
    const age = observationAge(manifest.generatedAt, now)
    const url = new URL(request.url)
    const sourceId = url.searchParams.get('source')
    if (sourceId) {
      const source = manifest.sources.find((item) => item.id === sourceId)
      if (!source || source.status === 'unchecked') return json({ error: 'Источник расписаний не подключён' }, 404)
      const today = localDate(now)
      const complete = (['mogilev-minsk', 'minsk-mogilev'] as const).every((direction) => [0, 1, 2].every((day) => source.coverage?.some((item) =>
        item.direction === direction && item.date === addDays(today, day) && item.status === 'ok' && observationAge(item.checkedAt, now) <= 20 * 60000)))
      return json({ healthy: complete, source: sourceId, status: source.status, lastSuccessAt: source.lastSuccessAt ?? null }, complete ? 200 : 503)
    }
    const snapshotsPresent = (await Promise.all(Object.values(manifest.directions).map((key) => kv.get<unknown>(key, 'json')))).every((value) =>
      !!value && typeof value === 'object' && 'trips' in value && Array.isArray(value.trips))
    const healthy = age <= 20 * 60000 && snapshotsPresent
    return json({ healthy, reason: healthy ? 'ok' : snapshotsPresent ? 'collector_delayed' : 'missing_snapshot',
      generatedAt: manifest.generatedAt, ageMinutes: Number.isFinite(age) ? Math.floor(age / 60000) : null,
      sources: { connected: manifest.sources.filter((source) => source.status !== 'unchecked').length,
        failed: manifest.sources.filter((source) => source.status === 'error' || source.status === 'stale').length } }, healthy ? 200 : 503)
  } catch { return json({ healthy: false, reason: 'storage_unavailable' }, 503) }
}
