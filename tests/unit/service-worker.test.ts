import { readFileSync } from 'node:fs'
import { runInNewContext } from 'node:vm'
import { describe, expect, it, vi } from 'vitest'

function worker(fetcher = vi.fn(async () => new Response('fresh asset'))) {
  const listeners = new Map<string, (event: Record<string, unknown>) => void>()
  const client = { url: 'https://site.test/', navigate: vi.fn(async () => undefined) }
  const caches = { keys: vi.fn(async () => ['mm-static-v3', 'mm-static-v4']), delete: vi.fn(async () => true),
    open: vi.fn(async () => ({ addAll: vi.fn(async () => undefined), put: vi.fn(async () => undefined) })),
    match: vi.fn(async (key: string | Request) => key === '/' ? new Response('<html>old app</html>') : undefined) }
  const context = { self: { location: { origin: 'https://site.test' }, addEventListener: (name: string, handler: (event: Record<string, unknown>) => void) => listeners.set(name, handler),
    skipWaiting: vi.fn(), clients: { claim: vi.fn(async () => undefined), matchAll: vi.fn(async () => [client]) } }, caches, fetch: fetcher, URL, Response }
  runInNewContext(readFileSync('public/sw.js', 'utf8'), context)
  return { listeners, context, client, caches }
}

describe('service worker retires stale app clients without caching private schedules', () => {
  it('does not intercept API, off-origin or non-GET requests', () => {
    const { listeners } = worker()
    for (const request of [new Request('https://site.test/api/trips'), new Request('https://other.test/asset.js'), new Request('https://site.test/', { method: 'POST' })]) {
      const respondWith = vi.fn()
      listeners.get('fetch')!({ request, respondWith })
      expect(respondWith).not.toHaveBeenCalled()
    }
  })
  it('reloads old open clients after activating the new worker', async () => {
    const { listeners, client, caches } = worker()
    const pending: Promise<unknown>[] = []
    listeners.get('activate')!({ waitUntil: (promise: Promise<unknown>) => pending.push(promise) })
    await Promise.all(pending)
    expect(caches.delete).toHaveBeenCalledWith('mm-static-v3')
    expect(client.navigate).toHaveBeenCalledWith('https://site.test/')
  })
  it('does not return HTML in place of a missing JavaScript asset when offline', async () => {
    const { listeners } = worker(vi.fn(async () => { throw new Error('offline') }))
    let response: Promise<Response> | undefined
    listeners.get('fetch')!({ request: new Request('https://site.test/assets/missing.js'), waitUntil: vi.fn(),
      respondWith: (promise: Promise<Response>) => { response = promise } })
    expect((await response!)?.status).toBe(503)
    expect(await (await response!).text()).not.toContain('<html>')
  })
})
