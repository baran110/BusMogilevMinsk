// Read-only live acceptance. Secrets and cookies stay in this process, never in logs.
import { createHmac } from 'node:crypto'
import { isTripsResponse } from '../src/lib/validation'
import { requestedPairs } from './lib/coverage'
import { fetchWithTimeout } from './lib/fetch'

const account = process.env.CLOUDFLARE_ACCOUNT_ID, token = process.env.CLOUDFLARE_API_TOKEN
if (!account || !/^[a-f0-9]{32}$/.test(account) || !token) throw new Error('Cloudflare credentials are not configured')
const response = await fetchWithTimeout(`https://api.cloudflare.com/client/v4/accounts/${account}/pages/projects/bus-mogilev-minsk`, {
  redirect: 'error', headers: { Authorization: `Bearer ${token}` },
})
const project = await response.json() as { result?: { deployment_configs?: { production?: { env_vars?: Record<string, { value?: string }> } } } }
const variables = project.result?.deployment_configs?.production?.env_vars
let grants: Array<{ id: string; hash: string; revoked?: boolean }> = []
try { grants = JSON.parse(variables?.ACCESS_KEYS?.value ?? '') } catch { /* Cloudflare may hide secret values. */ }
const secret = variables?.SESSION_SECRET?.value
const grant = Array.isArray(grants) ? grants.find((item) => !item.revoked && /^passenger-\d{2}$/.test(item.id) && /^[a-f0-9]{64}$/.test(item.hash)) : undefined
const canVerifySession = !!grant && typeof secret === 'string' && secret.length >= 32 && !/^\*+$/.test(secret)
console.log(JSON.stringify({ storedGrantCount: grants.length || null, automaticSessionVerificationAvailable: canVerifySession }))
let cookie: string | undefined
if (canVerifySession) {
  // A five-minute session for an existing grant; no new passenger or permission is created.
  const sign = (value: string) => createHmac('sha256', secret!).update(value).digest('base64url')
  const payload = Buffer.from(JSON.stringify({ v: 1, id: grant!.id, exp: Math.floor(Date.now() / 1000) + 300,
    grant: sign(`grant:${grant!.id}:${grant!.hash}`) })).toString('base64url')
  cookie = `__Host-mm-session=${payload}.${sign(payload)}`
}
let failed = false
for (const host of ['https://bus-mogilev-minsk.pages.dev', 'https://mm-routes-mirror.vojtenkoa695.workers.dev']) {
  const firstPair = requestedPairs(1)[0]
  const denied = await fetch(`${host}/api/trips?${new URLSearchParams(firstPair)}`, { signal: AbortSignal.timeout(25000), redirect: 'error' })
  const health = await fetch(`${host}/api/health`, { signal: AbortSignal.timeout(25000), redirect: 'error' })
  const status = await health.json() as { healthy?: boolean; generatedAt?: string }
  const errors: string[] = []
  if (denied.status !== 401) errors.push(`Unauthenticated API HTTP ${denied.status}`)
  if (health.status !== 200 || status.healthy !== true) errors.push(`Health HTTP ${health.status}`)
  let validPairs = 0, trips = 0
  if (cookie) {
    for (const pair of requestedPairs(30)) {
      const result = await fetch(`${host}/api/trips?${new URLSearchParams(pair)}`, {
        headers: { Cookie: cookie }, signal: AbortSignal.timeout(25000), redirect: 'error',
      })
      const body = await result.json().catch(() => null)
      if (result.status !== 200 || !isTripsResponse(body, pair.direction, pair.date)) errors.push(`${pair.direction}/${pair.date}: HTTP ${result.status} or invalid schema`)
      else { validPairs++; trips += body.trips.length }
    }
  }
  console.log(JSON.stringify({ liveAcceptance: host, unauthenticatedStatus: denied.status, healthStatus: health.status,
    generatedAt: status.generatedAt, verifiedDateDirectionPairs: validPairs, tripsAcrossHorizon: trips, errors,
    loginWithPassengerKeyTested: false }))
  failed ||= errors.length > 0
}
if (!canVerifySession) console.log(JSON.stringify({ acceptanceLimitation: 'Cloudflare hides secrets; passenger-key sign-in still requires owner verification' }))
if (failed) process.exitCode = 1
