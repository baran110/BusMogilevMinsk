import { handleSessionRequest, type AuthEnv } from './_auth'

export const onRequest: PagesFunction<AuthEnv> = ({ request, env }) => handleSessionRequest(request, env)
