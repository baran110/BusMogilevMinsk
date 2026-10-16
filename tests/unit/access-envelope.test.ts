import { generateKeyPairSync } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import { openAccessBundle, sealAccessBundle } from '../../scripts/lib/access-envelope'

const pair = () => generateKeyPairSync('rsa', { modulusLength: 3072, publicKeyEncoding: { type: 'spki', format: 'pem' }, privateKeyEncoding: { type: 'pkcs8', format: 'pem' } })
const keys = pair()
const context = 'a'.repeat(40)
describe('private access delivery through public encrypted artifacts', () => {
  it('round-trips only with the intended private key and contains no plaintext', () => {
    const plaintext = JSON.stringify({ key: 'private-passenger-key', secret: 'private-session-secret' })
    const envelope = sealAccessBundle(plaintext, keys.publicKey, context)
    expect(JSON.stringify(envelope)).not.toContain('private-passenger-key')
    expect(openAccessBundle(envelope, keys.privateKey)).toBe(plaintext)
    expect(() => openAccessBundle(envelope, pair().privateKey)).toThrow()
  })
  it('rejects modified ciphertext, release identity and malformed parameters', () => {
    const envelope = sealAccessBundle('secret', keys.publicKey, context)
    const changed = Buffer.from(envelope.ciphertext, 'base64'); changed[0] ^= 1
    expect(() => openAccessBundle({ ...envelope, ciphertext: changed.toString('base64') }, keys.privateKey)).toThrow()
    expect(() => openAccessBundle({ ...envelope, context: 'b'.repeat(40) }, keys.privateKey)).toThrow()
    expect(() => openAccessBundle({ ...envelope, iv: '***' }, keys.privateKey)).toThrow()
  })
})
