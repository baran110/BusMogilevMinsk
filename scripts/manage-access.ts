import { randomBytes, createHash } from 'node:crypto'
import { chmod, mkdir, readFile, writeFile } from 'node:fs/promises'
import { resolve } from 'node:path'

const [command, argument] = process.argv.slice(2)
const directory = resolve('.private-access')
const registryPath = resolve(directory, 'registry.json')
interface Grant { id: string; hash: string; revoked?: boolean }

async function save(registry: Grant[], secret: string): Promise<void> {
  await writeFile(registryPath, JSON.stringify(registry, null, 2), { mode: 0o600 }); await chmod(registryPath, 0o600)
  const path = resolve(directory, 'cloudflare-secrets.json')
  await writeFile(path, JSON.stringify({ ACCESS_KEYS: JSON.stringify(registry), SESSION_SECRET: secret }, null, 2), { mode: 0o600 }); await chmod(path, 0o600)
}

if (command === 'issue' && /^[1-9]$|^10$/.test(argument || '')) {
  const count = Number(argument)
  await mkdir(directory, { recursive: true, mode: 0o700 })
  try { await readFile(registryPath); throw new Error('Реестр уже существует. Не перезаписывайте выданные ключи; для замены используйте отдельную защищённую копию.') }
  catch (error) { if (!(error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT')) throw error }
  const registry: Grant[] = []
  const issued: string[] = []
  for (let i = 0; i < count; i++) {
    const id = `passenger-${String(i + 1).padStart(2, '0')}`
    const key = `MM-${randomBytes(32).toString('base64url')}`
    registry.push({ id, hash: createHash('sha256').update(key).digest('hex') })
    issued.push(`${id}: ${key}`)
  }
  await writeFile(resolve(directory, 'issued-keys.txt'), issued.join('\n') + '\n', { mode: 0o600 })
  await save(registry, randomBytes(48).toString('base64url'))
  console.log(`Создано ${count} ключей в .private-access. Значения ключей не выводятся и не отправляются в Cloudflare.`)
} else if (command === 'revoke' && /^passenger-\d{2}$/.test(argument || '')) {
  const registry = JSON.parse(await readFile(registryPath, 'utf8')) as Grant[]
  const grant = registry.find((entry) => entry.id === argument)
  if (!grant) throw new Error('Такой ключ не найден')
  grant.revoked = true
  const vars = JSON.parse(await readFile(resolve(directory, 'cloudflare-secrets.json'), 'utf8')) as { SESSION_SECRET: string }
  await save(registry, vars.SESSION_SECRET)
  console.log(`Ключ ${argument} отозван в локальном реестре. Для рабочего сервиса владелец должен обновить ACCESS_KEYS на обоих адресах.`)
} else {
  throw new Error('Использование: pnpm access:manage issue 10 | pnpm access:manage revoke passenger-01')
}
