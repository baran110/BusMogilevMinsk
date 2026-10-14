import { afterEach, describe, expect, it, vi } from 'vitest'
import { dispatchCollection } from '../../scheduler'

afterEach(() => vi.unstubAllGlobals())
const now = Date.parse('2026-10-14T09:10:00Z')
const slot = Math.floor(now / 600000)
const env = { GITHUB_TOKEN: 'test-only-token' }
describe('external timer dispatch without stale-job accumulation', () => {
  it('dispatches full first, then near, with the current slot and fixed main', async () => {
    for (const hasFull of [false, true]) {
      const dispatches: unknown[] = []
      vi.stubGlobal('fetch', vi.fn(async (url: string, init: RequestInit) => {
        if (url.endsWith('/dispatches')) { dispatches.push(JSON.parse(String(init.body))); return new Response(null, { status: 204 }) }
        if (url.includes('/runs?')) return new Response(JSON.stringify({ workflow_runs: hasFull ? [{ name: `collect/full/${slot - 1}`, head_branch: 'main', status: 'completed', conclusion: 'success' }] : [] }))
        return new Response('{"state":"active"}')
      }))
      expect(await dispatchCollection(env, now)).toBe('dispatched')
      expect(dispatches).toEqual([{ ref: 'main', inputs: { mode: hasFull ? 'near' : 'full', slot: String(slot), confirm: 'publish' } }])
    }
  })
  it('skips a busy or duplicate slot and rejects a disabled workflow', async () => {
    for (const [run, expected] of [[{ name: 'collect/near/old', status: 'in_progress' }, 'busy'], [{ name: `collect/near/${slot}`, status: 'completed' }, 'duplicate']] as const) {
      const fetcher = vi.fn(async (url: string) => new Response(JSON.stringify(url.includes('/runs?') ? { workflow_runs: [{ ...run, head_branch: 'main' }] } : { state: 'active' })))
      vi.stubGlobal('fetch', fetcher)
      expect(await dispatchCollection(env, now)).toBe(expected)
      expect(fetcher).toHaveBeenCalledTimes(2)
    }
    vi.stubGlobal('fetch', vi.fn(async () => new Response('{"state":"disabled_inactivity"}')))
    await expect(dispatchCollection(env, now)).rejects.toThrow('disabled')
  })
  it('does not hide an expired GitHub token or invalid API response', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('{}', { status: 401 })))
    await expect(dispatchCollection(env, now)).rejects.toThrow('401')
    await expect(dispatchCollection({}, now)).rejects.toThrow('not configured')
  })
})
