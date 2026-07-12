import type { DirectionSnapshot, SnapshotManifest } from '../../src/types'

const apiBase = (account: string, namespace: string) => `https://api.cloudflare.com/client/v4/accounts/${account}/storage/kv/namespaces/${namespace}`

function credentials() {
  const account = process.env.CLOUDFLARE_ACCOUNT_ID
  const namespace = process.env.KV_NAMESPACE_ID
  const token = process.env.CLOUDFLARE_API_TOKEN
  if (!account || !namespace || !token) return undefined
  return { account, namespace, token }
}

export async function readKv<T>(key: string): Promise<T | undefined> {
  const auth = credentials()
  if (!auth) return undefined
  const response = await fetch(`${apiBase(auth.account, auth.namespace)}/values/${encodeURIComponent(key)}`, { headers: { Authorization: `Bearer ${auth.token}` } })
  if (!response.ok) return undefined
  return response.json() as Promise<T>
}

export async function readPrevious(): Promise<{ manifest?: SnapshotManifest; snapshots: Partial<Record<'mogilev-minsk' | 'minsk-mogilev', DirectionSnapshot>> }> {
  const manifest = await readKv<SnapshotManifest>('manifest:active')
  if (!manifest) return { snapshots: {} }
  const [outbound, inbound] = await Promise.all([
    readKv<DirectionSnapshot>(manifest.directions['mogilev-minsk']),
    readKv<DirectionSnapshot>(manifest.directions['minsk-mogilev']),
  ])
  return { manifest, snapshots: { 'mogilev-minsk': outbound, 'minsk-mogilev': inbound } }
}

export async function publishSnapshots(manifest: SnapshotManifest, snapshots: DirectionSnapshot[]): Promise<void> {
  const auth = credentials()
  if (!auth) throw new Error('Cloudflare credentials are not configured')
  const entries = snapshots.map((snapshot) => ({
    key: manifest.directions[snapshot.direction],
    value: JSON.stringify(snapshot),
    expiration_ttl: 172800,
  }))
  const bulk = await fetch(`${apiBase(auth.account, auth.namespace)}/bulk`, {
    method: 'PUT',
    headers: { Authorization: `Bearer ${auth.token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(entries),
  })
  if (!bulk.ok) throw new Error(`KV bulk write failed: ${bulk.status} ${await bulk.text()}`)
  const activate = await fetch(`${apiBase(auth.account, auth.namespace)}/values/${encodeURIComponent('manifest:active')}`, {
    method: 'PUT',
    headers: { Authorization: `Bearer ${auth.token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(manifest),
  })
  if (!activate.ok) throw new Error(`KV manifest write failed: ${activate.status} ${await activate.text()}`)
}
