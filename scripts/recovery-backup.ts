import { generateKeyPairSync } from 'node:crypto'
import { mkdir, readFile, writeFile, access } from 'node:fs/promises'
import { resolve } from 'node:path'
import { captureRecoveryBackup, openRecoveryBackup, sealRecoveryBackup } from './lib/recovery-backup'

const directory = resolve('.private-recovery')
const publicPath = resolve('data/recovery-backup-public.pem')
const privatePath = resolve(directory, 'recovery-private.pem')
const [command, argument] = process.argv.slice(2)
try {
  if (command === 'keygen' && !argument) {
    for (const path of [publicPath, privatePath]) {
      let exists = false
      try { await access(path); exists = true } catch { /* New local backup key only. */ }
      if (exists) throw new Error('Backup key already exists')
    }
    await mkdir(directory, { recursive: true, mode: 0o700 })
    const pair = generateKeyPairSync('rsa', { modulusLength: 3072,
      publicKeyEncoding: { type: 'spki', format: 'pem' }, privateKeyEncoding: { type: 'pkcs8', format: 'pem' } })
    await writeFile(privatePath, pair.privateKey, { flag: 'wx', mode: 0o600 })
    await writeFile(publicPath, pair.publicKey, { flag: 'wx', mode: 0o644 })
    console.log(JSON.stringify({ backupKeyPrepared: true, productionCredentialsChanged: false, privateKeyPrinted: false }))
  } else if (command === 'capture' && !argument) {
    const context = process.env.GITHUB_SHA ?? ''
    const captured = await captureRecoveryBackup({ account: process.env.CLOUDFLARE_ACCOUNT_ID ?? '',
      namespace: process.env.KV_NAMESPACE_ID ?? '', token: process.env.CLOUDFLARE_API_TOKEN ?? '' }, context, process.env.SCHEDULER_TOKEN_CONFIGURED === 'true')
    const envelope = sealRecoveryBackup(captured.bundle, await readFile(publicPath, 'utf8'), context)
    await mkdir(directory, { recursive: true, mode: 0o700 })
    await writeFile(resolve(directory, 'cloudflare-backup.encrypted.json'), JSON.stringify(envelope), { flag: 'wx', mode: 0o600 })
    // Never print the raw configuration, values, account identity or secrets.
    console.log(JSON.stringify({ recoveryBackupEncrypted: true, ...captured.summary }))
  } else if (command === 'open' && argument) {
    const envelope = JSON.parse(await readFile(resolve(argument), 'utf8'))
    const value = openRecoveryBackup(envelope, await readFile(privatePath, 'utf8'))
    await writeFile(resolve(directory, 'cloudflare-backup.json'), JSON.stringify(value, null, 2), { flag: 'wx', mode: 0o600 })
    console.log(JSON.stringify({ recoveryBackupDecrypted: true, contentsPrinted: false }))
  } else throw new Error('Invalid command')
} catch {
  console.error('Резерв не подготовлен: проверьте режим keygen|capture|open FILE, защищённые настройки и локальные файлы. Содержимое и секреты скрыты.')
  process.exitCode = 1
}
