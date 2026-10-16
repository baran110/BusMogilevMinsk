interface SchedulerEnv { GITHUB_TOKEN?: string }
const repository = 'baran110/BusMogilevMinsk'
const api = `https://api.github.com/repos/${repository}/actions/workflows/`
interface Run { status: string; conclusion: string | null; head_branch: string; display_title: string; created_at: string }

async function github(workflow: string, path: string, env: SchedulerEnv, body?: unknown): Promise<Response> {
  if (!env.GITHUB_TOKEN) throw new Error('Scheduler token is not configured')
  const response = await fetch(`${api}${workflow}${path}`, { method: body === undefined ? 'GET' : 'POST',
    headers: { Authorization: `Bearer ${env.GITHUB_TOKEN}`, Accept: 'application/vnd.github+json',
      'Content-Type': 'application/json', 'X-GitHub-Api-Version': '2022-11-28', 'User-Agent': 'MM-Routes-Scheduler' },
    body: body === undefined ? undefined : JSON.stringify(body), signal: AbortSignal.timeout(10_000), redirect: 'error' })
  if (!response.ok) throw new Error(`GitHub scheduler HTTP ${response.status}`)
  return response
}

async function workflowRuns(workflowId: string, env: SchedulerEnv): Promise<Run[]> {
  const workflow = await (await github(workflowId, '', env)).json() as { state?: string }
  if (workflow.state !== 'active') throw new Error(`Workflow ${workflowId} is disabled; owner must enable it before activating the timer`)
  const runs = await (await github(workflowId, '/runs?event=workflow_dispatch&per_page=30', env)).json() as { workflow_runs?: Run[] }
  if (!Array.isArray(runs.workflow_runs) || runs.workflow_runs.some((run) => typeof run.status !== 'string'
    || typeof run.head_branch !== 'string' || typeof run.display_title !== 'string'
    || !Number.isFinite(Date.parse(run.created_at)))) throw new Error('GitHub returned an invalid workflow list')
  return runs.workflow_runs.filter((run) => run.head_branch === 'main')
}
function busy(runs: Run[], timestamp: number, activeLimitMinutes: number): boolean {
  return runs.some((run) => {
    if (!['queued', 'in_progress', 'waiting', 'pending', 'requested'].includes(run.status)) return false
    // Old queued dispatches fail their first-step slot guard. An abandoned API
    // record must not stop all later updates forever. Active limits include the
    // workflow's queue allowance, job timeout and a small reporting margin.
    const limit = run.status === 'in_progress' ? activeLimitMinutes : 11
    return timestamp - Date.parse(run.created_at) <= limit * 60000
  })
}

export async function dispatchCollection(env: SchedulerEnv, timestamp: number): Promise<'dispatched' | 'busy' | 'duplicate'> {
  const main = await workflowRuns('collect.yml', env)
  if (busy(main, timestamp, 25)) return 'busy'
  const slot = Math.floor(timestamp / 600000)
  // REST `name` is the workflow name; YAML run-name is exposed as display_title.
  if (main.some((run) => run.display_title === `collect/near/${slot}` || run.display_title === `collect/full/${slot}`)) return 'duplicate'
  const hour = Math.floor(timestamp / 3600000)
  const fullThisHour = main.some((run) => run.display_title.startsWith('collect/full/') && run.conclusion === 'success'
    && Math.floor(Number(run.display_title.split('/').at(-1)) / 6) === hour)
  const mode = fullThisHour ? 'near' : 'full'
  await github('collect.yml', '/dispatches', env, { ref: 'main', inputs: { mode, slot: String(slot), confirm: 'publish' } })
  return 'dispatched'
}

export async function dispatchBzdFar(env: SchedulerEnv, timestamp: number): Promise<'dispatched' | 'busy' | 'duplicate'> {
  const runs = await workflowRuns('collect-bzd-far.yml', env)
  if (busy(runs, timestamp, 70)) return 'busy'
  const hour = Math.floor(timestamp / 3600000)
  // At most one automatic attempt per hour, including failures, to bound KV writes.
  if (runs.some((run) => run.display_title === `bzd/far/${hour}`)) return 'duplicate'
  await github('collect-bzd-far.yml', '/dispatches', env, { ref: 'main', inputs: { slot: String(hour), dispatch_slot: String(Math.floor(timestamp / 600000)), confirm: 'publish' } })
  return 'dispatched'
}

export async function dispatchUpdates(env: SchedulerEnv, timestamp: number) {
  const results = await Promise.allSettled([dispatchCollection(env, timestamp), dispatchBzdFar(env, timestamp)])
  const statuses = Object.fromEntries(results.map((result, i) => [i === 0 ? 'collection' : 'bzdFar',
    result.status === 'fulfilled' ? result.value : 'error']))
  console.log(JSON.stringify({ scheduler: statuses, slot: Math.floor(timestamp / 600000) }))
  const errors = results.flatMap((result) => result.status === 'rejected' ? [result.reason] : [])
  if (errors.length) throw new AggregateError(errors, 'One or more collection workflows could not be dispatched')
  return statuses
}

export default {
  async scheduled(controller: ScheduledController, env: SchedulerEnv): Promise<void> {
    // Await completion so failed dispatches appear as failed Cron invocations.
    await dispatchUpdates(env, controller.scheduledTime)
  },
  fetch(): Response { return new Response('Not found', { status: 404, headers: { 'Cache-Control': 'no-store' } }) },
}
