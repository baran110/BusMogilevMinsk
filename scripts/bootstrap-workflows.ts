import { bootstrapWorkflows } from './lib/bootstrap'

const token = process.env.GH_TOKEN
const expectedSha = process.env.GITHUB_SHA
if (!token || !expectedSha) throw new Error('GitHub workflow credentials are not configured')
await bootstrapWorkflows(token, expectedSha)
