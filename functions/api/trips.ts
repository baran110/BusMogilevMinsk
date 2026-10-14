import { handleProtectedTrips } from './_service'
import type { AuthEnv } from './_auth'

interface Env extends AuthEnv {
  TRIPS_KV: KVNamespace
}

export const onRequestGet: PagesFunction<Env> = async ({ request, env }) => handleProtectedTrips(request, env)

export const onRequest: PagesFunction<Env> = async (context) => {
  return onRequestGet(context)
}
