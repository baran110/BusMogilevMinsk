// Read-only diagnostic. Never writes KV, triggers collection or prints credentials/trip details.
import { readKv } from './lib/kv'
import { DIRECTIONS, isManifest, isSnapshot } from '../src/lib/validation'
import { observationAge } from '../src/lib/trips'
import type { DirectionSnapshot, SnapshotManifest } from '../src/types'

const configuredNamespace = 'b9fbd39948c441308ef317ec81e0a5e5'
console.log(JSON.stringify({ namespaceMatchesRepository: process.env.KV_NAMESPACE_ID === configuredNamespace }))
try {
  const manifest = await readKv<SnapshotManifest>('manifest:active')
  console.log(JSON.stringify({ manifestPresent: !!manifest, manifestValid: isManifest(manifest), generatedAt: manifest?.generatedAt,
    ageMinutes: manifest?.generatedAt ? Math.round(observationAge(manifest.generatedAt, new Date()) / 60000) : null }))
  for (const direction of DIRECTIONS) {
    const activeKey = manifest?.directions?.[direction]
    // Inspect valid legacy references too; a stricter new validator must not masquerade as a missing key.
    const allowedReference = typeof activeKey === 'string' && activeKey.length < 200 && activeKey.startsWith('snapshot:') && activeKey.endsWith(`:${direction}`)
    const active = allowedReference ? await readKv<DirectionSnapshot>(activeKey) : undefined
    const backup = await readKv<DirectionSnapshot>(`backup:${direction}`)
    console.log(JSON.stringify({ direction, activeReferenceRead: allowedReference, activePresent: !!active, activeValid: isSnapshot(active, direction),
      generatedAt: active?.generatedAt, trips: active?.trips?.length ?? null, backupPresent: !!backup, backupValid: isSnapshot(backup, direction) }))
  }
} catch (error) {
  console.error(error instanceof Error ? error.message : 'Не удалось прочитать KV')
  process.exitCode = 1
}
