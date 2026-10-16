import { generateKeyPairSync } from 'node:crypto'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { openAccessBundle, publicKeyId, sealAccessBundle } from './lib/access-envelope'

const directory = resolve('.private-access')
const privatePath = resolve(directory, 'delivery-private.pem')
const publicPath = resolve('data/release-access-public.pem')
const [command, argument] = process.argv.slice(2)
await mkdir(directory, { recursive: true, mode: 0o700 })
if (command === 'keygen') {
  const pair = generateKeyPairSync('rsa', { modulusLength: 3072, publicKeyEncoding: { type: 'spki', format: 'pem' }, privateKeyEncoding: { type: 'pkcs8', format: 'pem' } })
  await writeFile(privatePath, pair.privateKey, { flag: 'wx', mode: 0o600 })
  await writeFile(publicPath, pair.publicKey, { flag: 'wx', mode: 0o644 })
  console.log(JSON.stringify({ deliveryKeyId: publicKeyId(pair.publicKey), privateKeyPrinted: false }))
} else if (command === 'seal') {
  const publicKey = await readFile(publicPath, 'utf8')
  const issuedKeys = await readFile(resolve(directory, 'issued-keys.txt'), 'utf8')
  const variables = JSON.parse(await readFile(resolve(directory, 'cloudflare-secrets.json'), 'utf8'))
  const context = process.env.GITHUB_SHA ?? ''
  const envelope = sealAccessBundle(JSON.stringify({ version: 1, release: context, issuedKeys, variables }), publicKey, context)
  await writeFile(resolve(directory, 'access-bundle.encrypted.json'), JSON.stringify(envelope), { flag: 'wx', mode: 0o600 })
  console.log(JSON.stringify({ encrypted: true, deliveryKeyId: envelope.keyId, release: context }))
} else if (command === 'open' && argument) {
  const envelope = JSON.parse(await readFile(resolve(argument), 'utf8'))
  const contents = JSON.parse(openAccessBundle(envelope, await readFile(privatePath, 'utf8')))
  if (contents.release !== envelope.context || typeof contents.issuedKeys !== 'string' || !contents.variables) throw new Error('Invalid access bundle contents')
  await writeFile(resolve(directory, 'issued-keys.txt'), contents.issuedKeys, { flag: 'wx', mode: 0o600 })
  await writeFile(resolve(directory, 'cloudflare-secrets.json'), JSON.stringify(contents.variables, null, 2), { flag: 'wx', mode: 0o600 })
  console.log(JSON.stringify({ decrypted: true, release: contents.release, keysPrinted: false }))
} else throw new Error('Usage: node --import tsx scripts/access-envelope.ts keygen|seal|open ENCRYPTED_PATH')
