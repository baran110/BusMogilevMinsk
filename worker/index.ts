import { handleProtectedTrips } from '../functions/api/_service'
import { handleSessionRequest, type AuthEnv } from '../functions/api/_auth'
import { handleHealthRequest } from '../functions/api/_health'

interface Env extends AuthEnv {
  ASSETS: Fetcher
  TRIPS_KV: KVNamespace
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url)
    if (url.pathname === '/api/trips') return handleProtectedTrips(request, env)
    if (url.pathname === '/api/session') return handleSessionRequest(request, env)
    if (url.pathname === '/api/health') return handleHealthRequest(request, env.TRIPS_KV)
    if (url.pathname.startsWith('/api/')) {
      return new Response(JSON.stringify({ error: 'Метод API не найден' }), {
        status: 404,
        headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' },
      })
    }
    if (url.pathname === '/' || (!url.pathname.includes('.') && request.headers.get('Accept')?.includes('text/html'))) {
      url.pathname = '/index.html'
      return env.ASSETS.fetch(new Request(url, request))
    }
    return env.ASSETS.fetch(request)
  },
}
