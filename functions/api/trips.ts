import { handleTripsRequest } from './_service'

interface Env {
  TRIPS_KV: KVNamespace
}

export const onRequestGet: PagesFunction<Env> = async ({ request, env }) => handleTripsRequest(request, env.TRIPS_KV)

export const onRequest: PagesFunction<Env> = async (context) => {
  if (context.request.method !== 'GET') return new Response(JSON.stringify({ error: 'Метод не поддерживается' }), { status: 405, headers: { 'Content-Type': 'application/json', Allow: 'GET' } })
  return onRequestGet(context)
}
