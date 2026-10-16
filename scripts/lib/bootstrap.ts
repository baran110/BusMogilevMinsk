export async function bootstrapWorkflows(token: string, expectedSha: string): Promise<void> {
  // Runs only after the approved release; no Cloudflare secrets are needed here.
  const repository = 'baran110/BusMogilevMinsk'
  const api = `https://api.github.com/repos/${repository}`
  async function github(path: string, body?: unknown, method?: 'PUT'): Promise<any> {
    const response = await fetch(`${api}/${path}`, { method: method ?? (body === undefined ? 'GET' : 'POST'), redirect: 'error',
      signal: AbortSignal.timeout(15_000), headers: { Authorization: `Bearer ${token}`, Accept: 'application/vnd.github+json',
        'Content-Type': 'application/json', 'X-GitHub-Api-Version': '2022-11-28', 'User-Agent': 'MM-Routes-Approved-Release' },
      body: body === undefined ? undefined : JSON.stringify(body) })
    if (!response.ok) throw new Error(`GitHub workflow API HTTP ${response.status}`)
    return response.status === 204 ? undefined : response.json()
  }
  const pause = () => new Promise((resolve) => setTimeout(resolve, 10_000))
  async function assertHead() {
    const ref = await github('git/ref/heads/main')
    if (ref.object?.sha !== expectedSha) throw new Error('Main changed; refuse to dispatch a different release')
  }
  async function dispatchAndWait(workflow: string, inputs: Record<string, string>, title: string, timeoutMinutes: number) {
    await assertHead()
    const metadata = await github(`actions/workflows/${workflow}`)
    if (metadata.state !== 'active') {
      await github(`actions/workflows/${workflow}/enable`, undefined, 'PUT')
      console.log(JSON.stringify({ enabledWorkflow: workflow }))
    }
    const before = await github(`actions/workflows/${workflow}/runs?event=workflow_dispatch&per_page=10`)
    const ids = new Set(before.workflow_runs.map((run: any) => run.id))
    await github(`actions/workflows/${workflow}/dispatches`, { ref: 'main', inputs: { ...inputs, confirm: 'publish' } })
    const deadline = Date.now() + timeoutMinutes * 60000
    let id: number | undefined
    while (Date.now() < deadline) {
      if (!id) {
        const response = await github(`actions/workflows/${workflow}/runs?event=workflow_dispatch&per_page=10`)
        const run = response.workflow_runs.find((item: any) => !ids.has(item.id) && item.head_sha === expectedSha && item.display_title === title)
        if (run) { id = run.id; console.log(JSON.stringify({ dispatchedWorkflow: workflow, runId: id })) }
      }
      if (id) {
        const run = await github(`actions/runs/${id}`)
        if (run.status === 'completed') {
          console.log(JSON.stringify({ workflow, runId: id, conclusion: run.conclusion }))
          if (run.conclusion !== 'success') throw new Error(`${workflow} failed; inspect run ${id}`)
          return
        }
      }
      await pause()
    }
    throw new Error(`${workflow} exceeded the release observation window; inspect Actions before retrying`)
  }
  const startedAt = Date.now()
  const slot = String(Math.floor(startedAt / 600000)), hour = String(Math.floor(startedAt / 3600000))
  // Separate workflows preserve the normal concurrency and provider request limits.
  await Promise.all([
    dispatchAndWait('collect.yml', { mode: 'full', slot }, `collect/full/${slot}`, 15),
    dispatchAndWait('collect-bzd-far.yml', { slot: hour, dispatch_slot: slot }, `bzd/far/${hour}`, 58),
  ])
  const finalSlot = String(Math.floor(Date.now() / 600000))
  await dispatchAndWait('collect.yml', { mode: 'near', slot: finalSlot }, `collect/near/${finalSlot}`, 15)
  console.log(JSON.stringify({ bootstrapCompleted: true, automaticTimerEnabled: false }))
}
