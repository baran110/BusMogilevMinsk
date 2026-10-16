// Read-only release inspection. Never logs credential values or modifies Cloudflare.
import { fetchWithTimeout } from './lib/fetch'

const account = process.env.CLOUDFLARE_ACCOUNT_ID
const token = process.env.CLOUDFLARE_API_TOKEN
if (!account || !/^[a-f0-9]{32}$/.test(account) || !token) throw new Error('Cloudflare credentials are not configured')
const expectedNamespace = 'b9fbd39948c441308ef317ec81e0a5e5'
const root = `https://api.cloudflare.com/client/v4/accounts/${account}`
async function get(path: string) {
  const response = await fetchWithTimeout(`${root}/${path}`, { redirect: 'error', headers: { Authorization: `Bearer ${token}` } })
  const body = await response.json() as { success?: boolean; result?: Record<string, any> }
  if (body.success !== true || !body.result) throw new Error('Cloudflare did not confirm a valid response')
  return body.result
}
const checks = await Promise.allSettled([
  (async () => {
    const project = await get('pages/projects/bus-mogilev-minsk')
    const production = project.deployment_configs?.production
    console.log(JSON.stringify({ preflight: 'pages', project: project.name, productionBranch: project.production_branch,
      accessRegistryPresent: !!production?.env_vars?.ACCESS_KEYS, sessionSecretPresent: !!production?.env_vars?.SESSION_SECRET,
      kvMatchesRepository: production?.kv_namespaces?.TRIPS_KV?.namespace_id === expectedNamespace,
      source: project.source?.type ?? null, automaticProductionDeployment: project.source?.config?.production_deployments_enabled ?? project.source?.config?.deployments_enabled ?? null,
      automaticPreviewDeployment: project.source?.config?.preview_deployment_setting ?? null,
      productionDeploymentId: project.canonical_deployment?.id ?? null,
      productionCommit: project.canonical_deployment?.deployment_trigger?.metadata?.commit_hash ?? null }))
  })(),
  (async () => {
    const settings = await get('workers/scripts/mm-routes-mirror/settings')
    const bindings = settings.bindings as Array<{ name: string; type: string; namespace_id?: string }> | undefined
    console.log(JSON.stringify({ preflight: 'worker', accessRegistryPresent: !!bindings?.some((binding) => binding.name === 'ACCESS_KEYS'),
      sessionSecretPresent: !!bindings?.some((binding) => binding.name === 'SESSION_SECRET'),
      kvMatchesRepository: bindings?.find((binding) => binding.name === 'TRIPS_KV')?.namespace_id === expectedNamespace,
      compatibilityDate: settings.compatibility_date, usageModel: settings.usage_model ?? null }))
  })(),
  (async () => {
    const deployments = await get('workers/scripts/mm-routes-mirror/deployments')
    console.log(JSON.stringify({ preflight: 'worker-deployments', deployments: (deployments.deployments ?? []).slice(0, 2).map((item: any) => ({
      id: item.id, createdAt: item.created_on, versions: item.versions?.map((version: any) => ({ id: version.version_id, percentage: version.percentage })),
    })) }))
  })(),
])
checks.forEach((check, index) => {
  if (check.status === 'rejected') {
    console.error(JSON.stringify({ preflightFailed: ['pages', 'worker', 'worker-deployments'][index],
      reason: check.reason instanceof Error ? check.reason.message.slice(0, 180) : 'Read failed' }))
    process.exitCode = 1
  }
})
