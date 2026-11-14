import { afterEach, describe, expect, it, vi } from 'vitest'
import { bootstrapWorkflows } from '../../scripts/lib/bootstrap'

afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks() })
describe('approved release bootstrap', () => {
  it.each([false, true, 'phantom', 'far_failure'])('handles abandoned queue=%s, waits for both collectors, then publishes the combined near snapshot', async (queued) => {
    const sha = 'a'.repeat(40)
    const runs: Array<{ id: number; workflow: string; head_sha: string; display_title: string }> = []
    const methods: string[] = []
    let cancelled = false
    vi.spyOn(console, 'log').mockImplementation(() => {})
    vi.stubGlobal('fetch', vi.fn(async (url: string, init: RequestInit) => {
      const path = new URL(url).pathname
      if (path.endsWith('/runs/38901133829/cancel')) {
        cancelled = true; methods.push('cancel'); return new Response(null, { status: queued === 'phantom' ? 409 : 202 })
      }
      if (path.endsWith('/runs/38901133829/jobs')) return Response.json({ total_count: 0, jobs: [] })
      if (path.endsWith('/runs/38901133829')) return Response.json(queued && queued !== 'far_failure' && !cancelled
        ? { status: 'queued', head_sha: '6051fd7a4c7202920948261641a2d37ee5d9a741', path: '.github/workflows/collect.yml', created_at: '2026-10-16T12:31:38Z' }
        : { status: 'completed' })
      if (init.method === 'PUT') { methods.push('enable'); return new Response(null, { status: 204 }) }
      if (path.endsWith('/git/ref/heads/main')) return Response.json({ object: { sha } })
      const workflow = path.match(/workflows\/([^/]+)/)?.[1]
      if (path.endsWith('/dispatches')) {
        const { inputs, ref } = JSON.parse(String(init.body))
        expect(ref).toBe('main'); expect(inputs.confirm).toBe('publish')
        runs.push({ id: runs.length + 1, workflow: workflow!, head_sha: sha,
          display_title: workflow === 'collect.yml' ? `collect/${inputs.mode}/${inputs.slot}` : `bzd/far/${inputs.slot}` })
        methods.push(workflow === 'collect.yml' ? inputs.mode : 'far')
        return new Response(null, { status: 204 })
      }
      if (path.endsWith('/runs')) return Response.json({ workflow_runs: runs.filter((run) => run.workflow === workflow) })
      if (/actions\/runs\/\d+$/.test(path)) {
        const run = runs.find((item) => String(item.id) === path.split('/').at(-1))
        return Response.json({ status: 'completed', conclusion: queued === 'far_failure' && run?.workflow === 'collect-bzd-far.yml' ? 'failure' : 'success' })
      }
      return Response.json({ state: 'disabled_inactivity' })
    }))
    if (queued === 'far_failure') await expect(bootstrapWorkflows('test-only-token', sha)).rejects.toThrow('Partial recovery published')
    else await bootstrapWorkflows('test-only-token', sha)
    expect(runs).toHaveLength(3)
    expect(methods.filter((method) => method !== 'enable')).toEqual([...(queued && queued !== 'far_failure' ? ['cancel'] : []), 'full', 'far', 'near'])
  })

  it('refuses publication if main moved after the reviewed release', async () => {
    const writes: string[] = []
    vi.stubGlobal('fetch', vi.fn(async (url: string, init: RequestInit) => {
      if (init.method !== 'GET') writes.push(url)
      return Response.json({ object: { sha: 'b'.repeat(40) } })
    }))
    await expect(bootstrapWorkflows('test-only-token', 'a'.repeat(40))).rejects.toThrow('Main changed')
    expect(writes).toHaveLength(0)
  })

  it.each(['in_progress', 'queued'])('does not cancel an active or unrecognised collection (%s)', async (status) => {
    const writes: string[] = []
    vi.stubGlobal('fetch', vi.fn(async (url: string, init: RequestInit) => {
      if (init.method !== 'GET') writes.push(url)
      return Response.json(url.endsWith('/git/ref/heads/main')
        ? { object: { sha: 'a'.repeat(40) } } : { status, head_sha: 'b'.repeat(40) })
    }))
    await expect(bootstrapWorkflows('test-only-token', 'a'.repeat(40))).rejects.toThrow(/active|differs/)
    expect(writes).toHaveLength(0)
  })

  it('does not ignore HTTP 409 if the queued record contains jobs', async () => {
    const writes: string[] = []
    vi.stubGlobal('fetch', vi.fn(async (url: string, init: RequestInit) => {
      if (init.method !== 'GET') { writes.push(url); return new Response(null, { status: 409 }) }
      if (url.endsWith('/git/ref/heads/main')) return Response.json({ object: { sha: 'a'.repeat(40) } })
      if (url.includes('/jobs?')) return Response.json({ total_count: 1, jobs: [{ status: 'queued' }] })
      return Response.json({ status: 'queued', head_sha: '6051fd7a4c7202920948261641a2d37ee5d9a741', path: '.github/workflows/collect.yml', created_at: '2026-10-16T12:31:38Z' })
    }))
    await expect(bootstrapWorkflows('test-only-token', 'a'.repeat(40))).rejects.toThrow('HTTP 409')
    expect(writes).toHaveLength(1)
    expect(writes[0]).toMatch(/\/cancel$/)
  })
})
