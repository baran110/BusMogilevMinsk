import { afterEach, describe, expect, it, vi } from 'vitest'
import { dispatchBzdFar, dispatchCollection, dispatchUpdates } from '../../scheduler'

afterEach(() => vi.unstubAllGlobals())
const now = Date.parse('2026-10-14T09:10:00Z')
const slot = Math.floor(now / 600000)
const created_at = new Date(now).toISOString()
const env = { GITHUB_TOKEN: 'test-only-token' }
describe('external timer dispatch without stale-job accumulation', () => {
  it('dispatches full first, then near, with the current slot and fixed main', async () => {
    for (const hasFull of [false, true]) {
      const dispatches: unknown[] = []
      vi.stubGlobal('fetch', vi.fn(async (url: string, init: RequestInit) => {
        if (url.endsWith('/dispatches')) { dispatches.push(JSON.parse(String(init.body))); return new Response(null, { status: 204 }) }
        if (url.includes('/runs?')) return new Response(JSON.stringify({ workflow_runs: hasFull ? [{ name: 'Обновление расписания', display_title: `collect/full/${slot - 1}`, head_branch: 'main', created_at, status: 'completed', conclusion: 'success' }] : [] }))
        return new Response('{"state":"active"}')
      }))
      expect(await dispatchCollection(env, now)).toBe('dispatched')
      expect(dispatches).toEqual([{ ref: 'main', inputs: { mode: hasFull ? 'near' : 'full', slot: String(slot), confirm: 'publish' } }])
    }
  })
  it('skips a busy or duplicate slot and rejects a disabled workflow', async () => {
    for (const [run, expected] of [[{ name: 'Обновление расписания', display_title: 'collect/near/old', status: 'in_progress' }, 'busy'], [{ name: 'Обновление расписания', display_title: `collect/near/${slot}`, status: 'completed' }, 'duplicate']] as const) {
      const fetcher = vi.fn(async (url: string) => new Response(JSON.stringify(url.includes('/runs?') ? { workflow_runs: [{ ...run, head_branch: 'main', created_at }] } : { state: 'active' })))
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
    vi.stubGlobal('fetch', vi.fn(async (url: string) => new Response(JSON.stringify(url.includes('/runs?')
      ? { workflow_runs: [{ name: `collect/near/${slot}`, head_branch: 'main', created_at, status: 'completed' }] } : { state: 'active' }))))
    await expect(dispatchCollection(env, now)).rejects.toThrow('invalid workflow list')
  })

  it('dispatches far dates once per hour and never repeats a failed hourly attempt', async () => {
    const hour = Math.floor(now / 3600000)
    for (const attempted of [false, true]) {
      const dispatches: unknown[] = []
      vi.stubGlobal('fetch', vi.fn(async (url: string, init: RequestInit) => {
        if (url.endsWith('/dispatches')) { dispatches.push(JSON.parse(String(init.body))); return new Response(null, { status: 204 }) }
        return new Response(JSON.stringify(url.includes('/runs?') ? { workflow_runs: attempted ? [{ name: 'Обновление расписания', display_title: `bzd/far/${hour}`, head_branch: 'main', created_at, status: 'completed', conclusion: 'failure' }] : [] } : { state: 'active' }))
      }))
      expect(await dispatchBzdFar(env, now)).toBe(attempted ? 'duplicate' : 'dispatched')
      expect(dispatches).toEqual(attempted ? [] : [{ ref: 'main', inputs: { slot: String(hour), dispatch_slot: String(slot), confirm: 'publish' } }])
    }
  })

  it('dispatches the main cycle while a long BZD workflow is busy, and vice versa', async () => {
    for (const busyFar of [false, true]) {
      const dispatches: string[] = []
      vi.stubGlobal('fetch', vi.fn(async (url: string) => {
        if (url.endsWith('/dispatches')) { dispatches.push(url); return new Response(null, { status: 204 }) }
        const occupied = url.includes('collect-bzd-far.yml') === busyFar
        return new Response(JSON.stringify(url.includes('/runs?') ? { workflow_runs: occupied ? [{ name: 'Обновление расписания', display_title: 'old', head_branch: 'main', created_at, status: 'in_progress' }] : [] } : { state: 'active' }))
      }))
      expect(await dispatchUpdates(env, now)).toEqual({ collection: busyFar ? 'dispatched' : 'busy', bzdFar: busyFar ? 'busy' : 'dispatched' })
      expect(dispatches).toHaveLength(1)
      expect(dispatches[0].includes('collect-bzd-far.yml')).toBe(!busyFar)
    }
  })

  it('still dispatches the main cycle if the far workflow is disabled, then reports the error', async () => {
    const dispatches: string[] = []
    vi.stubGlobal('fetch', vi.fn(async (url: string) => {
      if (url.endsWith('/dispatches')) { dispatches.push(url); return new Response(null, { status: 204 }) }
      if (url.includes('/runs?')) return new Response('{"workflow_runs":[]}')
      return new Response(JSON.stringify({ state: url.includes('collect-bzd-far.yml') ? 'disabled_inactivity' : 'active' }))
    }))
    await expect(dispatchUpdates(env, now)).rejects.toThrow('could not be dispatched')
    expect(dispatches).toHaveLength(1)
    expect(dispatches[0]).toContain('/collect.yml/dispatches')
  })

  it('ignores an abandoned queued record but still respects a recent queued run', async () => {
    for (const minutes of [5, 120]) {
      const posts: string[] = []
      vi.stubGlobal('fetch', vi.fn(async (url: string, init: RequestInit) => {
        if (url.endsWith('/dispatches')) { posts.push(url); return new Response(null, { status: 204 }) }
        return Response.json(url.includes('/runs?') ? { workflow_runs: [{ head_branch: 'main', display_title: 'Обновление расписания',
          status: 'queued', created_at: new Date(now - minutes * 60000).toISOString() }] } : { state: 'active' })
      }))
      expect(await dispatchCollection(env, now)).toBe(minutes === 5 ? 'busy' : 'dispatched')
      expect(posts).toHaveLength(minutes === 5 ? 0 : 1)
    }
  })

  it('keeps a legitimately long far job busy without blocking the near workflow', async () => {
    vi.stubGlobal('fetch', vi.fn(async (url: string) => Response.json(url.includes('/runs?') ? { workflow_runs: [{ head_branch: 'main',
      display_title: 'bzd/far/old', status: 'in_progress', created_at: new Date(now - 50 * 60000).toISOString() }] } : { state: 'active' })))
    expect(await dispatchBzdFar(env, now)).toBe('busy')
  })
})
