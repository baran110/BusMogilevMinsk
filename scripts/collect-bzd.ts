import { mkdir, writeFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { bzdStageKey, saveBzdStage } from './lib/bzd-stage'
import { collectBzdBatches } from './lib/bzd-collection'
import { readKv } from './lib/kv'

const args = process.argv.slice(2)
const batchArg = args.find((arg) => /^--batch=[0-5]$/.test(arg))
if (args.some((arg) => !['--local', '--publish', '--near', '--far', batchArg].includes(arg))
  || (batchArg && (!args.includes('--local') || !args.includes('--far')))
  || new Set(args).size !== args.length
  || args.includes('--near') === args.includes('--far') || args.includes('--local') === args.includes('--publish')) {
  throw new Error('Укажите --near или --far и ровно один режим: --local (без KV) или --publish (запись KV только после разрешения)')
}
const local = args.includes('--local')
const scope = args.includes('--near') ? 'near' : 'far'
const successful = await collectBzdBatches(scope, {
  part: batchArg ? Number(batchArg.split('=')[1]) : undefined,
  read: async (batch) => local ? undefined : readKv(bzdStageKey(batch)),
  write: async (stage) => {
    if (!local) return saveBzdStage(stage)
    await mkdir(resolve('data/snapshots'), { recursive: true })
    await writeFile(resolve(`data/snapshots/bzd-${stage.scope}-${stage.part}.json`), JSON.stringify(stage, null, 2), 'utf8')
  },
  completed: (stage) => console.log(JSON.stringify({ bzdPackage: bzdStageKey(stage), status: stage.result.health.status,
    confirmedPairs: stage.result.health.coverage?.filter((item) => item.status === 'ok').length ?? 0,
    trips: stage.result.trips.length, localOnly: local })),
})
if (!successful) process.exitCode = 1
