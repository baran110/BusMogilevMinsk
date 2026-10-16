import { constants, createCipheriv, createDecipheriv, createHash, createPublicKey, privateDecrypt, publicEncrypt, randomBytes } from 'node:crypto'

export interface AccessEnvelope {
  version: 1
  context: string
  keyId: string
  wrappedKey: string
  iv: string
  tag: string
  ciphertext: string
}
const aad = (context: string) => Buffer.from(`mm-routes-access/1/${context}`)
export const publicKeyId = (key: string) => createHash('sha256').update(createPublicKey(key).export({ type: 'spki', format: 'der' })).digest('hex')

export function sealAccessBundle(plaintext: string, publicKey: string, context: string): AccessEnvelope {
  if (!/^[a-f0-9]{40}$/.test(context) || Buffer.byteLength(plaintext) > 64 * 1024) throw new Error('Invalid release context or bundle size')
  const key = randomBytes(32)
  const iv = randomBytes(12)
  const cipher = createCipheriv('aes-256-gcm', key, iv)
  cipher.setAAD(aad(context))
  const ciphertext = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()])
  const wrappedKey = publicEncrypt({ key: publicKey, padding: constants.RSA_PKCS1_OAEP_PADDING, oaepHash: 'sha256' }, key)
  key.fill(0)
  return { version: 1, context, keyId: publicKeyId(publicKey), wrappedKey: Buffer.from(wrappedKey).toString('base64'),
    iv: Buffer.from(iv).toString('base64'), tag: Buffer.from(cipher.getAuthTag()).toString('base64'), ciphertext: ciphertext.toString('base64') }
}

export function openAccessBundle(envelope: AccessEnvelope, privateKey: string): string {
  if (envelope.version !== 1 || !/^[a-f0-9]{40}$/.test(envelope.context) || envelope.keyId !== publicKeyId(privateKey)
    || ['wrappedKey', 'iv', 'tag', 'ciphertext'].some((field) => {
      const value = envelope[field as keyof AccessEnvelope]
      return typeof value !== 'string' || value.length > 100_000 || !/^[A-Za-z0-9+/]+={0,2}$/.test(value)
    })) throw new Error('Invalid encrypted access bundle')
  const key = privateDecrypt({ key: privateKey, padding: constants.RSA_PKCS1_OAEP_PADDING, oaepHash: 'sha256' }, Buffer.from(envelope.wrappedKey, 'base64'))
  try {
    const iv = Buffer.from(envelope.iv, 'base64'), tag = Buffer.from(envelope.tag, 'base64')
    if (key.length !== 32 || iv.length !== 12 || tag.length !== 16) throw new Error('Invalid encrypted access parameters')
    const decipher = createDecipheriv('aes-256-gcm', key, iv)
    decipher.setAAD(aad(envelope.context)); decipher.setAuthTag(tag)
    return Buffer.concat([decipher.update(Buffer.from(envelope.ciphertext, 'base64')), decipher.final()]).toString('utf8')
  } finally { key.fill(0) }
}
