interface SchedulerEnv { GITHUB_TOKEN?: string }
const repository = 'baran110/BusMogilevMinsk'
const api = `https://api.github.com/repos/${repository}/actions/workflows/collect.yml`
interface Run { status: string; conclusion: string | null; head_branch: string; name: string; created_at: string; run_started_at?: string }

async function github(path: string, env: SchedulerEnv, body?: unknown): Promise<Response> {
  if (!env.GITHUB_TOKEN) throw new Error('Scheduler token is not configured')
  const response = await fetch(`${api}${path}`, { method: body === undefined ? 'GET' : 'POST',
    headers: { Authorization: `Bearer ${env.GITHUB_TOKEN}`, Accept: 'application/vnd.github+json',
      'Content-Type': 'application/json', 'X-GitHub-Api-Version': '2022-11-28', 'User-Agent': 'MM-Routes-Scheduler' },
    body: body === undefined ? undefined : JSON.stringify(body), signal: AbortSignal.timeout(10_000), redirect: 'error' })
  if (!response.ok) throw new Error(`GitHub scheduler HTTP ${response.status}`)
  return response
}

export async function dispatchCollection(env: SchedulerEnv, timestamp: number): Promise<'dispatched' | 'busy' | 'duplicate'> {
  const workflow = await (await github('', env)).json() as { state?: string }
  if (workflow.state !== 'active') throw new Error('Workflow collect.yml is disabled; owner must enable it before activating the timer')
  const runs = await (await github('/runs?event=workflow_dispatch&per_page=30', env)).json() as { workflow_runs?: Run[] }
  if (!Array.isArray(runs.workflow_runs)) throw new Error('GitHub returned an invalid workflow list')
  const main = runs.workflow_runs.filter((run) => run.head_branch === 'main')
  if (main.some((run) => ['queued', 'in_progress', 'waiting', 'pending', 'requested'].includes(run.status))) return 'busy'
  const slot = Math.floor(timestamp / 600000)
  if (main.some((run) => run.name === `collect/near/${slot}` || run.name === `collect/full/${slot}`)) return 'duplicate'
  const hour = Math.floor(timestamp / 3600000)
  const fullThisHour = main.some((run) => run.name.startsWith('collect/full/') && run.conclusion === 'success'
    && Math.floor(Number(run.name.split('/').at(-1)) / 6) === hour)
  const mode = fullThisHour ? 'near' : 'full'
  await github('/dispatches', env, { ref: 'main', inputs: { mode, slot: String(slot), confirm: 'publish' } })
  return 'dispatched'
}

export default {
  async scheduled(controller: ScheduledController, env: SchedulerEnv): Promise<void> {
    // Await completion so failed dispatches appear as failed Cron invocations.
    console.log(JSON.stringify({ scheduler: await dispatchCollection(env, controller.scheduledTime), slot: Math.floor(controller.scheduledTime / 600000) }))
  },
  fetch(): Response { return new Response('Not found', { status: 404, headers: { 'Cache-Control': 'no-store' } }) },
}
