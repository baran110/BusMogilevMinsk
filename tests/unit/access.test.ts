import { describe, expect, it } from 'vitest'
import { authenticate, handleSessionRequest } from '../../functions/api/_auth'
import { TEST_KEY, testAuthEnv } from '../fixtures/schedule'

const origin = 'https://site.test'
const now = new Date('2026-10-14T09:00:00Z')
async function login(key = TEST_KEY) {
  return handleSessionRequest(new Request(`${origin}/api/session`, { method: 'POST', headers: { Origin: origin, 'Content-Type': 'application/json' }, body: JSON.stringify({ key }) }), await testAuthEnv(), now)
}
describe('server access keys', () => {
  it('fails closed when configuration is missing or has more than ten keys', async () => {
    expect((await authenticate(new Request(origin), {}, now))?.status).toBe(503)
    const env = await testAuthEnv()
    env.ACCESS_KEYS = JSON.stringify(Array.from({ length: 11 }, (_, i) => ({ id: String(i), hash: '0'.repeat(64) })))
    expect((await authenticate(new Request(origin), env, now))?.status).toBe(503)
  })
  it('issues a secure host-only session and accepts it without browser storage', async () => {
    const response = await login()
    expect(response.status).toBe(200)
    const cookie = response.headers.get('Set-Cookie')!
    expect(cookie).toContain('HttpOnly; Secure; SameSite=Lax')
    expect(cookie).not.toContain('Domain=')
    expect(response.headers.get('Cache-Control')).toContain('no-store')
    expect(await authenticate(new Request(origin, { headers: { Cookie: cookie.split(';')[0] } }), await testAuthEnv(), now)).toBeNull()
  })
  it('rejects wrong, expired, tampered, revoked and replaced grants', async () => {
    expect((await login('X'.repeat(40))).status).toBe(401)
    const cookie = (await login()).headers.get('Set-Cookie')!.split(';')[0]
    const request = new Request(origin, { headers: { Cookie: cookie } })
    expect((await authenticate(request, await testAuthEnv(), new Date(now.getTime() + 7 * 86400_000)))?.status).toBe(401)
    expect((await authenticate(new Request(origin, { headers: { Cookie: cookie + 'x' } }), await testAuthEnv(), now))?.status).toBe(401)
    for (const change of [{ revoked: true }, { hash: 'a'.repeat(64) }]) {
      const env = await testAuthEnv()
      env.ACCESS_KEYS = JSON.stringify(JSON.parse(env.ACCESS_KEYS!).map((key: object) => ({ ...key, ...change })))
      expect((await authenticate(request, env, now))?.status).toBe(401)
    }
  })
  it('rejects cross-origin mutations and oversized or malformed bodies', async () => {
    for (const method of ['POST', 'DELETE']) expect((await handleSessionRequest(new Request(`${origin}/api/session`, { method, headers: { Origin: 'https://other.test' } }), await testAuthEnv(), now)).status).toBe(403)
    expect((await login('x'.repeat(2000))).status).toBe(400)
    const response = await handleSessionRequest(new Request(`${origin}/api/session`, { method: 'DELETE', headers: { Origin: origin } }), {}, now)
    expect(response.headers.get('Set-Cookie')).toContain('Max-Age=0')
  })
})
