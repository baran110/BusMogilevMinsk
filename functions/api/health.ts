import { handleHealthRequest } from './_health'

export const onRequest: PagesFunction<{ TRIPS_KV: KVNamespace }> = ({ request, env }) => handleHealthRequest(request, env.TRIPS_KV)
