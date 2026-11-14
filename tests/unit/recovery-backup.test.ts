import { generateKeyPairSync } from 'node:crypto'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { captureRecoveryBackup, openRecoveryBackup, sealRecoveryBackup } from '../../scripts/lib/recovery-backup'

afterEach(() => vi.unstubAllGlobals())
const pair = generateKeyPairSync('rsa', { modulusLength: 2048,
  publicKeyEncoding: { type: 'spki', format: 'pem' }, privateKeyEncoding: { type: 'pkcs8', format: 'pem' } })
const context = 'a'.repeat(40)
const namespace = 'b9fbd39948c441308ef317ec81e0a5e5'
const auth = { account: 'a'.repeat(32), namespace, token: 'test-only-backup-token' }

describe('encrypted read-only recovery backup', () => {
  it('round-trips snapshots larger than the access-key envelope, authenticating context and contents', () => {
    const value = { data: 'private backup data '.repeat(7000) }
    const envelope = sealRecoveryBackup(value, pair.publicKey, context)
    expect(JSON.stringify(envelope)).not.toContain('private backup data')
    expect(openRecoveryBackup(envelope, pair.privateKey)).toEqual(value)
    expect(() => openRecoveryBackup({ ...envelope, context: 'b'.repeat(40) }, pair.privateKey)).toThrow()
    expect(() => openRecoveryBackup({ ...envelope, tag: Buffer.from(envelope.tag, 'base64').subarray(0, 4).toString('base64') }, pair.privateKey)).toThrow()
    expect(() => openRecoveryBackup({ ...envelope, ciphertext: Buffer.from('tampered').toString('base64') }, pair.privateKey)).toThrow()
  })

  function transport(changedManifest = false) {
    const manifest = { schemaVersion: 2, version: 'before', generatedAt: '2026-11-14T14:00:00Z', sources: [],
      directions: { 'mogilev-minsk': 'snapshot:before:mogilev-minsk', 'minsk-mogilev': 'snapshot:before:minsk-mogilev' } }
    let manifestReads = 0
    return vi.fn(async (url: string, init: RequestInit) => {
      expect(init.method).toBe('GET'); expect(init.body).toBeUndefined(); expect(init.redirect).toBe('error')
      expect(new Headers(init.headers).get('Authorization')).toBe(`Bearer ${auth.token}`)
      if (url.includes('/values/')) {
        const key = decodeURIComponent(url.split('/values/')[1])
        if (key === 'manifest:active') return Response.json({ ...manifest, version: changedManifest && ++manifestReads > 1 ? 'changed' : manifest.version })
        if (key.startsWith('snapshot:before:')) return Response.json({ data: key })
        return new Response('{}', { status: 404 })
      }
      if (url.includes('/keys?')) return Response.json({ success: true, result: [
        { name: 'manifest:active' }, { name: manifest.directions['mogilev-minsk'], expiration: 1800000000 },
        { name: manifest.directions['minsk-mogilev'] },
      ], result_info: { cursor: '' } })
      if (url.endsWith('/pages/projects/bus-mogilev-minsk')) return Response.json({ success: true, result: {
        canonical_deployment: { id: 'current-pages', deployment_trigger: { metadata: { commit_hash: context } } },
        deployment_configs: { production: { env_vars: { ACCESS_KEYS: { value: 'private-registry' }, SESSION_SECRET: { value: 'private-session' } },
          kv_namespaces: { TRIPS_KV: { namespace_id: namespace } } } },
      } })
      if (url.includes('mm-routes-scheduler/settings')) return new Response('{}', { status: 404 })
      if (url.endsWith('/settings')) return Response.json({ success: true, result: { bindings: [
        { name: 'ACCESS_KEYS' }, { name: 'SESSION_SECRET' }, { name: 'TRIPS_KV', namespace_id: namespace },
      ] } })
      if (url.endsWith('/schedules')) return Response.json({ success: true, result: { schedules: [] } })
      if (url.endsWith('/deployments')) return Response.json({ success: true, result: { deployments: [] } })
      throw new Error('Unexpected backup endpoint')
    })
  }

  it('reads only configuration and referenced KV values, preserving expiry and keeping secrets out of the summary', async () => {
    const fetcher = transport(); vi.stubGlobal('fetch', fetcher)
    const { summary, bundle } = await captureRecoveryBackup(auth, context, false)
    expect(summary).toMatchObject({ manifestValid: true, valuesPresent: 3, schedulerPresent: false, schedulerTokenConfigured: false,
      pagesAccessConfigured: true, mirrorAccessConfigured: true, pagesNamespaceMatches: true, mirrorNamespaceMatches: true })
    expect(bundle.entries.find((entry) => entry.key === 'snapshot:before:mogilev-minsk')?.expiration).toBe(1800000000)
    expect(JSON.stringify(summary)).not.toMatch(/private-registry|private-session|test-only-backup-token/)
    expect(JSON.stringify(bundle)).not.toContain(auth.token)
    expect(openRecoveryBackup(sealRecoveryBackup(bundle, pair.publicKey, context), pair.privateKey)).toEqual(JSON.parse(JSON.stringify(bundle)))
  })

  it('refuses a changing manifest or a different namespace without producing a misleading backup', async () => {
    const fetcher = transport(true); vi.stubGlobal('fetch', fetcher)
    await expect(captureRecoveryBackup(auth, context, false)).rejects.toThrow('Manifest changed')
    fetcher.mockClear()
    await expect(captureRecoveryBackup({ ...auth, namespace: 'b'.repeat(32) }, context, false)).rejects.toThrow('namespace')
    expect(fetcher).not.toHaveBeenCalled()
  })
})
