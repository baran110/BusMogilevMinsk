// Only reports whether initial access secrets may be created. Never replaces an existing registry.
import { appendFile } from 'node:fs/promises'
import { fetchWithTimeout } from './lib/fetch'

const account = process.env.CLOUDFLARE_ACCOUNT_ID, token = process.env.CLOUDFLARE_API_TOKEN
if (!account || !/^[a-f0-9]{32}$/.test(account) || !token) throw new Error('Cloudflare credentials are not configured')
async function get(path: string) {
  const response = await fetchWithTimeout(`https://api.cloudflare.com/client/v4/accounts/${account}/${path}`, {
    redirect: 'error', headers: { Authorization: `Bearer ${token}` },
  })
  const body = await response.json() as { success?: boolean; result?: any }
  if (!body.success || !body.result) throw new Error('Cloudflare configuration read failed')
  return body.result
}
const [pages, worker] = await Promise.all([get('pages/projects/bus-mogilev-minsk'), get('workers/scripts/mm-routes-mirror/settings')])
const variables = pages.deployment_configs?.production?.env_vars ?? {}
const bindings = worker.bindings as Array<{ name: string }>
const present = [!!variables.ACCESS_KEYS, !!variables.SESSION_SECRET,
  bindings.some((binding) => binding.name === 'ACCESS_KEYS'), bindings.some((binding) => binding.name === 'SESSION_SECRET')]
if (present.some(Boolean) && !present.every(Boolean)) throw new Error('Access secrets are incomplete; automatic initialization stopped without replacing existing keys')
const initialize = present.every((value) => !value)
if (process.env.GITHUB_OUTPUT) await appendFile(process.env.GITHUB_OUTPUT, `initialize=${initialize}\n`)
console.log(JSON.stringify({ initializeAccess: initialize, existingKeysReplaced: false }))
