import { afterEach, describe, expect, it, vi } from 'vitest'
import { bootstrapWorkflows } from '../../scripts/lib/bootstrap'

afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks() })
describe('approved release bootstrap', () => {
  it('enables inactive collectors, waits for both, then publishes the combined near snapshot', async () => {
    const sha = 'a'.repeat(40)
    const runs: Array<{ id: number; workflow: string; head_sha: string; display_title: string }> = []
    const methods: string[] = []
    vi.spyOn(console, 'log').mockImplementation(() => {})
    vi.stubGlobal('fetch', vi.fn(async (url: string, init: RequestInit) => {
      const path = new URL(url).pathname
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
      if (/actions\/runs\/\d+$/.test(path)) return Response.json({ status: 'completed', conclusion: 'success' })
      return Response.json({ state: 'disabled_inactivity' })
    }))
    await bootstrapWorkflows('test-only-token', sha)
    expect(runs).toHaveLength(3)
    expect(methods.filter((method) => method !== 'enable')).toEqual(['full', 'far', 'near'])
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
})
