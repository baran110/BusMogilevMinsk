import { afterEach, expect, it, vi } from 'vitest'
import { runGithubSchedule } from '../../scripts/lib/github-schedule'

afterEach(() => vi.unstubAllGlobals())
const now = Date.parse('2026-11-14T16:23:00Z')
const env = { GH_TOKEN: 'test-only-token', GITHUB_SHA: 'a'.repeat(40), GITHUB_RUN_ID: '1234',
  GITHUB_REPOSITORY: 'baran110/BusMogilevMinsk', GITHUB_REF: 'refs/heads/main' }

it('dispatches both workflows from a fresh scheduled main execution with current slots', async () => {
  const writes: unknown[] = []
  vi.stubGlobal('fetch', vi.fn(async (url: string, init: RequestInit) => {
    if (init.method === 'POST') { writes.push(JSON.parse(String(init.body))); return new Response(null, { status: 204 }) }
    if (url.endsWith('/runs/1234')) return Response.json({ created_at: new Date(now - 20_000).toISOString(), head_sha: env.GITHUB_SHA, head_branch: 'main', event: 'schedule' })
    return Response.json(url.includes('/runs?') ? { workflow_runs: [] } : { state: 'active' })
  }))
  expect(await runGithubSchedule(env, now)).toEqual({ collection: 'dispatched', bzdFar: 'dispatched' })
  expect(writes).toHaveLength(2)
  expect(writes[0]).toMatchObject({ ref: 'main', inputs: { mode: 'full', confirm: 'publish', slot: String(Math.floor(now / 600000)) } })
})

it.each(['stale', 'foreign', 'sha', 'event', 'clock'])('rejects invalid scheduler context before dispatch: %s', async (reason) => {
  const writes: string[] = []
  vi.stubGlobal('fetch', vi.fn(async (url: string, init: RequestInit) => {
    if (init.method === 'POST') writes.push(url)
    return Response.json({ created_at: new Date(now + (reason === 'stale' ? -600001 : reason === 'clock' ? 60001 : -1000)).toISOString(),
      head_sha: reason === 'sha' ? 'b'.repeat(40) : env.GITHUB_SHA, head_branch: 'main', event: reason === 'event' ? 'pull_request' : 'schedule' })
  }))
  await expect(runGithubSchedule({ ...env, GITHUB_REPOSITORY: reason === 'foreign' ? 'other/repo' : env.GITHUB_REPOSITORY }, now)).rejects.toThrow()
  expect(writes).toHaveLength(0)
})

it('requests activation only for an explicit fresh push and still dispatches normally', async () => {
  const requests: Array<{ url: string; method?: string }> = []
  vi.stubGlobal('fetch', vi.fn(async (url: string, init: RequestInit) => {
    requests.push({ url, method: init.method })
    if (init.method === 'PUT' || init.method === 'POST') return new Response(null, { status: 204 })
    if (url.endsWith('/runs/1234')) return Response.json({ created_at: new Date(now).toISOString(), head_sha: env.GITHUB_SHA, head_branch: 'main', event: 'push' })
    return Response.json(url.includes('/runs?') ? { workflow_runs: [] } : { state: 'active' })
  }))
  await runGithubSchedule(env, now, true)
  expect(requests.filter(x => x.method === 'PUT')).toEqual([{ url: 'https://api.github.com/repos/baran110/BusMogilevMinsk/actions/workflows/schedule.yml/enable', method: 'PUT' }])
  expect(requests.filter(x => x.method === 'POST')).toHaveLength(2)
})

it.each(['schedule', 'failure'])('does not dispatch after a forbidden or failed activation: %s', async (reason) => {
  const posts: string[] = []
  vi.stubGlobal('fetch', vi.fn(async (url: string, init: RequestInit) => {
    if (init.method === 'POST') posts.push(url)
    if (init.method === 'PUT') return new Response(null, { status: 403 })
    return Response.json({ created_at: new Date(now).toISOString(), head_sha: env.GITHUB_SHA, head_branch: 'main', event: reason === 'schedule' ? 'schedule' : 'push' })
  }))
  await expect(runGithubSchedule(env, now, true)).rejects.toThrow(/activation|Activation/)
  expect(posts).toHaveLength(0)
})
