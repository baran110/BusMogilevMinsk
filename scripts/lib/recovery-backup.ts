import { constants, createCipheriv, createDecipheriv, privateDecrypt, publicEncrypt, randomBytes } from 'node:crypto'
import { publicKeyId, type AccessEnvelope } from './access-envelope'
import { fetchWithTimeout, HttpError } from './fetch'
import { DIRECTIONS, isManifest } from '../../src/lib/validation'

const MAX_BYTES = 32 * 1024 * 1024
const aad = (context: string) => Buffer.from(`mm-routes-recovery/1/${context}`)
export function sealRecoveryBackup(value: unknown, publicKey: string, context: string): AccessEnvelope {
  const plaintext = Buffer.from(JSON.stringify(value))
  if (!/^[a-f0-9]{40}$/.test(context) || plaintext.length > MAX_BYTES) throw new Error('Invalid recovery backup context or size')
  const key = randomBytes(32), iv = randomBytes(12)
  try {
    const cipher = createCipheriv('aes-256-gcm', key, iv); cipher.setAAD(aad(context))
    const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()])
    return { version: 1, context, keyId: publicKeyId(publicKey),
      wrappedKey: Buffer.from(publicEncrypt({ key: publicKey, padding: constants.RSA_PKCS1_OAEP_PADDING, oaepHash: 'sha256' }, key)).toString('base64'),
      iv: Buffer.from(iv).toString('base64'), tag: Buffer.from(cipher.getAuthTag()).toString('base64'), ciphertext: ciphertext.toString('base64') }
  } finally { key.fill(0); plaintext.fill(0) }
}

export function openRecoveryBackup(envelope: AccessEnvelope, privateKey: string): unknown {
  if (envelope.version !== 1 || !/^[a-f0-9]{40}$/.test(envelope.context) || envelope.keyId !== publicKeyId(privateKey)
    || ['wrappedKey', 'iv', 'tag', 'ciphertext'].some((field) => {
      const value = envelope[field as keyof AccessEnvelope]
      return typeof value !== 'string' || value.length > MAX_BYTES * 1.5 || !/^[A-Za-z0-9+/]+={0,2}$/.test(value)
    })) throw new Error('Invalid recovery backup envelope')
  const iv = Buffer.from(envelope.iv, 'base64'), tag = Buffer.from(envelope.tag, 'base64'), ciphertext = Buffer.from(envelope.ciphertext, 'base64')
  if (iv.length !== 12 || tag.length !== 16 || ciphertext.length > MAX_BYTES || envelope.wrappedKey.length > 2048) throw new Error('Invalid recovery cipher parameters')
  const key = privateDecrypt({ key: privateKey, padding: constants.RSA_PKCS1_OAEP_PADDING, oaepHash: 'sha256' }, Buffer.from(envelope.wrappedKey, 'base64'))
  try {
    if (key.length !== 32) throw new Error('Invalid recovery encryption key')
    const decipher = createDecipheriv('aes-256-gcm', key, iv)
    decipher.setAAD(aad(envelope.context)); decipher.setAuthTag(tag)
    return JSON.parse(Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString('utf8'))
  } finally { key.fill(0) }
}

export interface RecoveryCredentials { account: string; namespace: string; token: string }
const expectedNamespace = 'b9fbd39948c441308ef317ec81e0a5e5'

/** GET-only snapshot. Raw configuration/values must be encrypted before leaving the process. */
export async function captureRecoveryBackup(auth: RecoveryCredentials, context: string, schedulerTokenConfigured: boolean) {
  if (!/^[a-f0-9]{32}$/.test(auth.account) || auth.namespace !== expectedNamespace || !auth.token || !/^[a-f0-9]{40}$/.test(context)) {
    throw new Error('Recovery credentials, namespace or commit are not configured')
  }
  const base = `https://api.cloudflare.com/client/v4/accounts/${auth.account}`
  const kv = `storage/kv/namespaces/${auth.namespace}`
  const get = async (path: string, optional = false): Promise<Response | null> => {
    try { return await fetchWithTimeout(`${base}/${path}`, { method: 'GET', redirect: 'error', headers: { Authorization: `Bearer ${auth.token}` } }) }
    catch (error) { if (optional && error instanceof HttpError && error.status === 404) return null; throw error }
  }
  const json = async (path: string, optional = false): Promise<any> => {
    const response = await get(path, optional)
    if (!response) return null
    const body = await response.json() as { success?: boolean; result?: unknown }
    if (body.success !== true || !body.result) throw new Error('Cloudflare did not confirm the backup read')
    return body.result
  }
  const readValue = async (key: string) => {
    const response = await get(`${kv}/values/${encodeURIComponent(key)}`, true)
    return response ? Buffer.from(await response.arrayBuffer()) : null
  }
  // Preserve expiration metadata without exporting unrelated historical values.
  const listing: Array<{ name: string; expiration?: number }> = []
  let cursor = ''
  const cursors = new Set<string>()
  do {
    const response = await get(`${kv}/keys?${new URLSearchParams({ limit: '1000', ...(cursor ? { cursor } : {}) })}`)
    const body = await response!.json() as { success?: boolean; result?: Array<{ name: string; expiration?: number }>; result_info?: { cursor?: string } }
    if (!body.success || !Array.isArray(body.result) || body.result.some((entry) => typeof entry.name !== 'string')) throw new Error('Invalid KV key listing')
    listing.push(...body.result)
    if (listing.length > 2000) throw new Error('KV listing exceeded the backup budget')
    cursor = body.result_info?.cursor ?? ''
    if (cursor && cursors.has(cursor)) throw new Error('KV listing cursor repeated')
    if (cursor) cursors.add(cursor)
  } while (cursor)
  const expirations = new Map(listing.map((entry) => [entry.name, entry.expiration]))
  const manifestBytes = await readValue('manifest:active')
  let manifest: unknown = null
  try { manifest = manifestBytes ? JSON.parse(manifestBytes.toString('utf8')) : null } catch { /* Preserve invalid bytes too. */ }
  const keys = new Set(['manifest:active', ...DIRECTIONS.map((direction) => `backup:${direction}`), 'source:bzd:near',
    ...Array.from({ length: 6 }, (_, i) => `source:bzd:far:${i}`)])
  if (isManifest(manifest)) for (const direction of DIRECTIONS) {
    for (const key of [manifest.directions[direction], manifest.previousDirections?.[direction]]) {
      if (!key) continue
      if (!key.startsWith('snapshot:') || !key.endsWith(`:${direction}`) || key.length > 200) throw new Error('Unsafe snapshot reference in manifest')
      keys.add(key)
    }
  }
  const [pages, mirrorSettings, mirrorDeployments, schedulerSettings] = await Promise.all([
    json('pages/projects/bus-mogilev-minsk'), json('workers/scripts/mm-routes-mirror/settings'),
    json('workers/scripts/mm-routes-mirror/deployments'), json('workers/scripts/mm-routes-scheduler/settings', true),
  ])
  const mirrorSchedules = await json('workers/scripts/mm-routes-mirror/schedules')
  const schedulerSchedules = schedulerSettings ? await json('workers/scripts/mm-routes-scheduler/schedules') : null
  const entries: Array<{ key: string; present: boolean; expiration?: number; valueBase64?: string }> = []
  let totalBytes = manifestBytes?.length ?? 0
  for (const key of keys) {
    const value = key === 'manifest:active' ? manifestBytes : await readValue(key)
    if (key !== 'manifest:active') totalBytes += value?.length ?? 0
    if (totalBytes > MAX_BYTES * 0.7) throw new Error('Recovery backup exceeded the read budget')
    entries.push({ key, present: value !== null, expiration: expirations.get(key), ...(value ? { valueBase64: value.toString('base64') } : {}) })
  }
  const after = await readValue('manifest:active')
  if (manifestBytes ? !after?.equals(manifestBytes) : after !== null) throw new Error('Manifest changed during the read-only backup; retry after inspecting collectors')
  const production = pages.deployment_configs?.production
  const mirrorBindings = Array.isArray(mirrorSettings.bindings) ? mirrorSettings.bindings : []
  const summary = { context, capturedAt: new Date().toISOString(), namespaceMatchesRepository: true,
    manifestPresent: manifestBytes !== null, manifestValid: isManifest(manifest), valuesPresent: entries.filter((item) => item.present).length,
    referencesChecked: entries.length, listedKeys: listing.length, productionDeploymentId: pages.canonical_deployment?.id ?? null,
    productionCommit: pages.canonical_deployment?.deployment_trigger?.metadata?.commit_hash ?? null,
    pagesAccessConfigured: !!production?.env_vars?.ACCESS_KEYS && !!production?.env_vars?.SESSION_SECRET,
    mirrorAccessConfigured: ['ACCESS_KEYS', 'SESSION_SECRET'].every((name) => mirrorBindings.some((binding: any) => binding.name === name)),
    pagesNamespaceMatches: production?.kv_namespaces?.TRIPS_KV?.namespace_id === expectedNamespace,
    mirrorNamespaceMatches: mirrorBindings.some((binding: any) => binding.name === 'TRIPS_KV' && binding.namespace_id === expectedNamespace),
    schedulerPresent: !!schedulerSettings, schedulerTokenConfigured,
    schedulerCronCount: schedulerSchedules?.schedules?.length ?? 0, mirrorCronCount: mirrorSchedules?.schedules?.length ?? 0 }
  return { summary, bundle: { version: 1, ...summary, account: auth.account, namespace: auth.namespace, entries,
    listing, configuration: { pages, mirrorSettings, mirrorDeployments, mirrorSchedules, schedulerSettings, schedulerSchedules } } }
}
