import type { Direction, DirectionSnapshot, SnapshotManifest } from '../../src/types'
import { DIRECTIONS, isManifest, isSnapshot } from '../../src/lib/validation'
import { isDeparted } from '../../src/lib/date'
import { observationAge } from '../../src/lib/trips'
import { fetchWithTimeout, HttpError } from './fetch'

const apiBase = (account: string, namespace: string) => `https://api.cloudflare.com/client/v4/accounts/${account}/storage/kv/namespaces/${namespace}`
export interface PreviousSnapshots { manifest?: SnapshotManifest; snapshots: Partial<Record<Direction, DirectionSnapshot>> }
function credentials() {
  const account = process.env.CLOUDFLARE_ACCOUNT_ID
  const namespace = process.env.KV_NAMESPACE_ID
  const token = process.env.CLOUDFLARE_API_TOKEN
  if (!account || !namespace || !token) throw new Error('Cloudflare credentials are not configured')
  if (!/^[a-f0-9]{32}$/.test(account) || !/^[a-f0-9]{32}$/.test(namespace)) throw new Error('Cloudflare identifiers have invalid format')
  return { account, namespace, token }
}

export async function readKv<T>(key: string): Promise<T | undefined> {
  const auth = credentials()
  try {
    const response = await fetchWithTimeout(`${apiBase(auth.account, auth.namespace)}/values/${encodeURIComponent(key)}`,
      { headers: { Authorization: `Bearer ${auth.token}` }, redirect: 'error' })
    return await response.json() as T
  } catch (error) {
    if (error instanceof HttpError && error.status === 404) return undefined
    throw error
  }
}

export async function readPrevious(): Promise<PreviousSnapshots> {
  const raw = await readKv<SnapshotManifest>('manifest:active')
  if (raw !== undefined && !isManifest(raw)) throw new Error('Активный manifest повреждён; требуется диагностика до публикации')
  const manifest = raw
  const snapshots: PreviousSnapshots['snapshots'] = {}
  await Promise.all(DIRECTIONS.map(async (direction) => {
    let snapshot = manifest ? await readKv<DirectionSnapshot>(manifest.directions[direction]) : undefined
    if (!isSnapshot(snapshot, direction) && manifest?.previousDirections?.[direction]) snapshot = await readKv<DirectionSnapshot>(manifest.previousDirections[direction]!)
    if (!isSnapshot(snapshot, direction)) snapshot = await readKv<DirectionSnapshot>(`backup:${direction}`)
    if (isSnapshot(snapshot, direction)) snapshots[direction] = snapshot
  }))
  return { manifest, snapshots }
}

export function validatePublication(manifest: SnapshotManifest, snapshots: DirectionSnapshot[], previous: PreviousSnapshots, now = new Date()): void {
  if (!isManifest(manifest) || snapshots.length !== 2 || !DIRECTIONS.every((direction) => {
    const snapshot = snapshots.find((item) => item.direction === direction)
    return isSnapshot(snapshot, direction) && snapshot.schemaVersion === 2 && snapshot.generatedAt === manifest.generatedAt
      && Buffer.byteLength(JSON.stringify(snapshot), 'utf8') <= 2 * 1024 * 1024
  })) throw new Error('Снимки не прошли проверку схемы, направлений или лимита размера')
  const freshCoverage = manifest.sources.flatMap((source) => source.coverage ?? []).filter((item) => item.status === 'ok' && observationAge(item.checkedAt, now) <= 10 * 60_000)
  if (!freshCoverage.length) throw new Error('Ни один источник не подтвердил расписание; старый manifest не переключён')
  for (const direction of DIRECTIONS) {
    const candidate = snapshots.find((item) => item.direction === direction)!
    const relevantDates = new Set(freshCoverage.filter((item) => item.direction === direction).map((item) => item.date))
    const before = (previous.snapshots[direction]?.trips ?? []).filter((trip) => relevantDates.has(trip.serviceDate) && !isDeparted(trip.departureAt, now))
    const after = candidate.trips.filter((trip) => relevantDates.has(trip.serviceDate) && !isDeparted(trip.departureAt, now))
    if (before.length >= 10 && after.length < before.length * 0.4) throw new Error(`Предложения ${direction} сократились более чем на 60%; требуется проверка, manifest не переключён`)
  }
}

async function put(path: string, body: unknown): Promise<void> {
  const auth = credentials()
  const response = await fetchWithTimeout(`${apiBase(auth.account, auth.namespace)}/${path}`, { method: 'PUT', redirect: 'error',
    headers: { Authorization: `Bearer ${auth.token}`, 'Content-Type': 'application/json' }, body: JSON.stringify(body) })
  const result = await response.json() as { success?: boolean }
  if (result.success !== true) throw new Error('Cloudflare не подтвердил запись KV')
}

export async function writeKvEntry(key: string, value: unknown, ttlSeconds: number): Promise<void> {
  const serialized = JSON.stringify(value)
  if (!Number.isInteger(ttlSeconds) || ttlSeconds < 60 || Buffer.byteLength(serialized, 'utf8') > 2 * 1024 * 1024) throw new Error('Неверный размер или срок хранения промежуточных данных')
  await put('bulk', [{ key, value: serialized, expiration_ttl: ttlSeconds }])
}

export async function publishSnapshots(manifest: SnapshotManifest, snapshots: DirectionSnapshot[], previous: PreviousSnapshots, now = new Date()): Promise<void> {
  validatePublication(manifest, snapshots, previous, now)
  const entries = snapshots.map((snapshot) => ({ key: manifest.directions[snapshot.direction], value: JSON.stringify(snapshot), expiration_ttl: 6 * 3600 }))
  // Two durable last-known copies are refreshed hourly. Their trip observation timestamps never change.
  if (manifest.mode === 'full') entries.push(...snapshots.map((snapshot) => ({ key: `backup:${snapshot.direction}`, value: JSON.stringify(snapshot), expiration_ttl: 7 * 86400 })))
  await put('bulk', entries)
  for (const direction of DIRECTIONS) {
    const stored = await readKv<DirectionSnapshot>(manifest.directions[direction])
    if (!isSnapshot(stored, direction) || stored.generatedAt !== manifest.generatedAt) throw new Error('Кандидат не подтверждён после записи KV; manifest не переключён')
  }
  const active = await readKv<SnapshotManifest>('manifest:active')
  if (active?.version !== previous.manifest?.version) throw new Error('Другой сборщик изменил manifest; переключение остановлено')
  await put(`values/${encodeURIComponent('manifest:active')}`, manifest)
}
