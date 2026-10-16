import { mkdir, writeFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import registry from '../data/sources.json'
import type { SourceRegistryEntry } from '../src/types'
import { readPrevious, publishSnapshots } from './lib/kv'
import { buildSnapshots } from './lib/snapshots'
import { collectionDeadline, withSourceDeadline } from './lib/runtime'
import { errorResult, type SourceResult } from './lib/source'
import { completeFailedCoverage, requestedPairs } from './lib/coverage'
import { collectAtlas } from './sources/atlas'
import { collectBusPro } from './sources/buspro'
import { collectBzd } from './sources/bzd'
import { collectTransporter } from './sources/transporter'
import { bzdStageKey, readBzdStagedResult, saveBzdStage } from './lib/bzd-stage'
import { collectBzdBatches } from './lib/bzd-collection'
import { readKv } from './lib/kv'
import { addDays, localDate } from '../src/lib/date'

const localOnly = process.argv.includes('--local')
const mode = process.argv.includes('--near') ? 'near' : 'full'
const horizon = mode === 'near' ? 3 : 30
const selected = process.env.SOURCE_IDS?.split(',').filter(Boolean)
if (selected && !localOnly) throw new Error('Выбор отдельных источников разрешён только при локальной диагностике')
const entries = (registry as SourceRegistryEntry[]).filter((source) => !selected || selected.includes(source.id))
const results = (await Promise.all(entries.map((source): Promise<SourceResult> => {
  if (!source.enabled || source.adapter === 'link-only' || source.adapter === 'availability') {
    return Promise.resolve({ trips: [], health: { id: source.id, name: source.name, kind: source.kind, url: source.url,
      status: 'unchecked', message: source.note || 'Расписание пока не подключено' } })
  }
  if (source.adapter === 'bzd-html' && !localOnly) {
    // Runs alongside the other adapters; publication awaits this source too.
    // Source cancellation ends before KV operations, so errors can still be saved.
    return (async () => {
      let failed = false
      try {
        await collectBzdBatches('near', { read: (batch) => readKv(bzdStageKey(batch)), write: saveBzdStage })
      } catch {
        failed = true
        console.warn(JSON.stringify({ source: 'bzd', stagingUpdate: 'failed', message: 'Ближний пакет не сохранён; остальные источники продолжают работу' }))
      }
      const result = await readBzdStagedResult(requestedPairs(30))
      if (!failed) return result
      const now = new Date()
      const nearEnd = addDays(localDate(now), 3)
      return { ...result,
        trips: result.trips.map((trip) => trip.serviceDate < nearEnd ? { ...trip,
          bookingOptions: trip.bookingOptions.map((option) => ({ ...option, lastKnown: true })) } : trip),
        health: { ...result.health, status: 'stale' as const, message: 'Ближний пакет БЖД не сохранён',
          coverage: result.health.coverage?.map((item) => item.date < nearEnd ? { ...item, status: 'error' as const, checkedAt: now.toISOString() } : item) },
      }
    })().catch((error) => errorResult(source.id, source.name, source.kind, source.url, error))
  }
  return withSourceDeadline<SourceResult>(collectionDeadline(source.id, mode), async () => {
    switch (source.adapter) {
      case 'transporter-api': return collectTransporter({ id: source.id, name: source.name, kind: source.kind,
        baseUrl: (source.apiUrl || source.url).replace(/\/$/, ''), bookingUrl: source.bookingUrl, cityIds: source.cityIds }, horizon)
      case 'buspro':
        if (!source.companyId) throw new Error('Для BusPro не задан идентификатор компании')
        return collectBusPro({ id: source.id, name: source.name, companyId: source.companyId, bookingUrl: source.bookingUrl }, horizon)
      case 'bzd-html': return collectBzd(horizon)
      case 'atlas':
        if (process.env.SKIP_BROWSER_SOURCES === '1') return { trips: [], health: { id: source.id, name: source.name,
          kind: source.kind, url: source.url, status: 'unchecked', message: 'Браузерная проверка явно отключена' } }
        return collectAtlas(horizon)
      default: throw new Error(`Адаптер ${source.adapter} не реализован`)
    }
  }).catch((error) => errorResult(source.id, source.name, source.kind, source.url, error))
}))).map((result) => completeFailedCoverage(result, requestedPairs(horizon)))
const previous = localOnly ? { snapshots: {} } : await readPrevious()
const { manifest, snapshots } = buildSnapshots(results, previous.snapshots, new Date(), mode)
if (!localOnly && previous.manifest) {
  manifest.previousDirections = previous.manifest.directions
  manifest.previousVersion = previous.manifest.version
}
for (const source of manifest.sources) console.log(JSON.stringify({ source: source.id, status: source.status, trips: source.tripsFound || 0,
  successfulDates: source.coverage?.filter((item) => item.status === 'ok').length || 0, message: source.message }))
if (localOnly) {
  const target = resolve('data/snapshots/diagnostic.json')
  await mkdir(resolve('data/snapshots'), { recursive: true })
  await writeFile(target, JSON.stringify({ manifest, snapshots }, null, 2), 'utf8')
  for (const snapshot of snapshots) {
    const sizeBytes = Buffer.byteLength(JSON.stringify(snapshot), 'utf8')
    console.log(JSON.stringify({ diagnostic: 'snapshot-budget', direction: snapshot.direction, trips: snapshot.trips.length,
      sizeBytes, withinSnapshotBudget: sizeBytes <= 2 * 1024 * 1024 }))
  }
  console.log(`Локальная проверка: ${snapshots.reduce((sum, snapshot) => sum + snapshot.trips.length, 0)} рейсов; внешняя публикация не выполнялась`)
} else {
  await publishSnapshots(manifest, snapshots, previous)
  console.log(`Published version ${manifest.version}: ${snapshots.map((snapshot) => `${snapshot.direction}=${snapshot.trips.length}`).join(', ')}`)
}
