import { dispatchUpdates } from '../../scheduler'

export async function runGithubSchedule(env: Record<string, string | undefined>, now = Date.now(), reactivate = false) {
  const token = env.GH_TOKEN, sha = env.GITHUB_SHA, id = env.GITHUB_RUN_ID
  if (!token || !/^[a-f0-9]{40}$/.test(sha ?? '') || !/^\d+$/.test(id ?? '')
    || env.GITHUB_REPOSITORY !== 'baran110/BusMogilevMinsk' || env.GITHUB_REF !== 'refs/heads/main') throw new Error('Invalid scheduler execution context')
  const response = await fetch(`https://api.github.com/repos/baran110/BusMogilevMinsk/actions/runs/${id}`, {
    redirect: 'error', signal: AbortSignal.timeout(10_000), headers: { Authorization: `Bearer ${token}`,
      Accept: 'application/vnd.github+json', 'User-Agent': 'MM-Routes-Schedule' },
  })
  if (!response.ok) throw new Error(`Scheduler context HTTP ${response.status}`)
  const run = await response.json() as { created_at?: string; head_sha?: string; head_branch?: string; event?: string }
  const age = now - Date.parse(run.created_at ?? '')
  if (run.head_sha !== sha || run.head_branch !== 'main' || !['schedule', 'push', 'workflow_dispatch'].includes(run.event ?? '')
    || !Number.isFinite(age) || age < -60_000 || age > 600_000) throw new Error('Scheduler execution is stale or inconsistent; no workflows dispatched')
  if (reactivate) {
    if (run.event === 'schedule') throw new Error('Scheduled events must not modify workflow activation')
    const enabled = await fetch('https://api.github.com/repos/baran110/BusMogilevMinsk/actions/workflows/schedule.yml/enable', {
      method: 'PUT', redirect: 'error', signal: AbortSignal.timeout(10_000), headers: { Authorization: `Bearer ${token}`,
        Accept: 'application/vnd.github+json', 'User-Agent': 'MM-Routes-Schedule' },
    })
    if (enabled.status !== 204) throw new Error(`Scheduler activation HTTP ${enabled.status}`)
    console.log(JSON.stringify({ schedulerActivationRequested: true, scheduledExecutionConfirmed: false }))
  }
  // Use current slots, never slots calculated before dependency installation.
  return dispatchUpdates({ GITHUB_TOKEN: token }, now)
}
