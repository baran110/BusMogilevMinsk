export interface AuthEnv {
  ACCESS_KEYS?: string
  SESSION_SECRET?: string
}

interface AccessKey { id: string; hash: string; revoked?: boolean }
interface Session { v: 1; id: string; exp: number; grant: string }
const COOKIE = '__Host-mm-session'
const SESSION_SECONDS = 7 * 24 * 60 * 60
const encoder = new TextEncoder()

export function json(body: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'private, no-store', 'X-Content-Type-Options': 'nosniff', ...headers } })
}

function config(env: AuthEnv): { keys: AccessKey[]; secret: string } {
  const keys: unknown = JSON.parse(env.ACCESS_KEYS || 'null')
  if (!Array.isArray(keys) || !keys.length || keys.length > 10 || !env.SESSION_SECRET || env.SESSION_SECRET.length < 32
    || !keys.every((key: unknown) => !!key && typeof key === 'object' && 'id' in key && 'hash' in key
      && typeof key.id === 'string' && /^[a-zA-Z0-9_-]{1,40}$/.test(key.id)
      && typeof key.hash === 'string' && /^[a-f0-9]{64}$/.test(key.hash)
      && (!('revoked' in key) || typeof key.revoked === 'boolean'))
    || new Set(keys.map((key) => key.id)).size !== keys.length
    || new Set(keys.map((key) => key.hash)).size !== keys.length) throw new Error('Access configuration unavailable')
  return { keys, secret: env.SESSION_SECRET }
}

function base64url(value: Uint8Array): string {
  return btoa(String.fromCharCode(...value)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '')
}
function decode(value: string): Uint8Array<ArrayBuffer> {
  if (!/^[a-zA-Z0-9_-]+$/.test(value)) throw new Error('Invalid session')
  return Uint8Array.from(atob(value.replace(/-/g, '+').replace(/_/g, '/')), (char) => char.charCodeAt(0))
}
async function hmac(secret: string): Promise<CryptoKey> {
  return crypto.subtle.importKey('raw', encoder.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign', 'verify'])
}
async function sign(value: string, key: CryptoKey): Promise<string> {
  return base64url(new Uint8Array(await crypto.subtle.sign('HMAC', key, encoder.encode(value))))
}
function cookie(value: string, age: number): string {
  return `${COOKIE}=${value}; Path=/; Max-Age=${age}; HttpOnly; Secure; SameSite=Lax`
}

export async function authenticate(request: Request, env: AuthEnv, now = new Date()): Promise<Response | null> {
  let configuration: ReturnType<typeof config>
  try { configuration = config(env) } catch { return json({ error: 'Вход временно недоступен. Владелец должен проверить настройку доступа.' }, 503) }
  try {
    const value = request.headers.get('Cookie')?.split(';').map((part) => part.trim()).find((part) => part.startsWith(`${COOKIE}=`))?.slice(COOKIE.length + 1)
    if (!value || value.length > 1024) throw new Error('Missing session')
    const parts = value.split('.')
    if (parts.length !== 2) throw new Error('Invalid session')
    const key = await hmac(configuration.secret)
    if (!await crypto.subtle.verify('HMAC', key, decode(parts[1]), encoder.encode(parts[0]))) throw new Error('Invalid signature')
    const session = JSON.parse(new TextDecoder().decode(decode(parts[0]))) as Session
    const grant = configuration.keys.find((entry) => entry.id === session.id && !entry.revoked)
    const seconds = Math.floor(now.getTime() / 1000)
    if (session.v !== 1 || !Number.isInteger(session.exp) || session.exp <= seconds || session.exp > seconds + SESSION_SECONDS
      || !grant || session.grant !== await sign(`grant:${grant.id}:${grant.hash}`, key)) throw new Error('Expired or revoked session')
    return null
  } catch { return json({ error: 'Введите ключ доступа.' }, 401) }
}

async function readKey(request: Request): Promise<string | null> {
  if (!request.headers.get('Content-Type')?.startsWith('application/json') || Number(request.headers.get('Content-Length') || 0) > 1024) return null
  const reader = request.body?.getReader()
  if (!reader) return null
  const chunks: Uint8Array[] = []
  let size = 0
  const timer = setTimeout(() => { void reader.cancel() }, 5_000)
  try {
    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      size += value.byteLength
      if (size > 1024) { await reader.cancel(); return null }
      chunks.push(value)
    }
    const bytes = new Uint8Array(size)
    let offset = 0
    for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.length }
    const body: unknown = JSON.parse(new TextDecoder().decode(bytes))
    if (!body || typeof body !== 'object' || !('key' in body) || typeof body.key !== 'string') return null
    const key = body.key.trim()
    return key.length >= 32 && key.length <= 128 ? key : null
  } catch { return null } finally { clearTimeout(timer); reader.releaseLock() }
}

export async function handleSessionRequest(request: Request, env: AuthEnv, now = new Date()): Promise<Response> {
  if (request.method === 'GET') return await authenticate(request, env, now) ?? json({ authenticated: true })
  if (!['POST', 'DELETE'].includes(request.method)) return json({ error: 'Метод не поддерживается' }, 405, { Allow: 'GET, POST, DELETE' })
  if (request.headers.get('Origin') !== new URL(request.url).origin) return json({ error: 'Недопустимый источник запроса' }, 403)
  if (request.method === 'DELETE') return json({ authenticated: false }, 200, { 'Set-Cookie': cookie('', 0) })
  let configuration: ReturnType<typeof config>
  try { configuration = config(env) } catch { return json({ error: 'Вход временно недоступен. Владелец должен проверить настройку доступа.' }, 503) }
  const rawKey = await readKey(request)
  if (!rawKey) return json({ error: 'Проверьте формат ключа доступа.' }, 400)
  const digest = Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', encoder.encode(rawKey))), (byte) => byte.toString(16).padStart(2, '0')).join('')
  const grant = configuration.keys.find((entry) => entry.hash === digest && !entry.revoked)
  if (!grant) return json({ error: 'Неверный или отозванный ключ доступа.' }, 401)
  const key = await hmac(configuration.secret)
  const session: Session = { v: 1, id: grant.id, exp: Math.floor(now.getTime() / 1000) + SESSION_SECONDS,
    grant: await sign(`grant:${grant.id}:${grant.hash}`, key) }
  const payload = base64url(encoder.encode(JSON.stringify(session)))
  return json({ authenticated: true }, 200, { 'Set-Cookie': cookie(`${payload}.${await sign(payload, key)}`, SESSION_SECONDS) })
}
