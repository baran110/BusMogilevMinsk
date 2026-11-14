import { mkdir, writeFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { runApiSmoke, smokePlan } from './lib/api-smoke'

const args = process.argv.slice(2)
if (args.length === 0 || (args.length === 1 && args[0] === '--plan')) {
  console.log(JSON.stringify({ mode: 'plan', ...smokePlan(), networkRequests: 0,
    note: 'Для согласованного запуска: --run и выбранный ключ в защищённой переменной MM_SMOKE_ACCESS_KEY. Ключи и cookies в отчёт не включаются.' }))
} else if (args.length === 1 && args[0] === '--run') {
  try {
    const key = process.env.MM_SMOKE_ACCESS_KEY ?? ''
    if (!key) throw new Error('Missing key')
    const report = await runApiSmoke(key)
    const directory = resolve('data/snapshots')
    await mkdir(directory, { recursive: true })
    await writeFile(resolve(directory, 'api-smoke-report.json'), JSON.stringify(report, null, 2), { mode: 0o600 })
    console.log(JSON.stringify({ mode: 'run', ready: report.ready, expectedRows: report.expectedRows, completedRows: report.rows.length,
      failedRows: report.rows.filter((row) => row.state === 'failed').length, degradedRows: report.rows.filter((row) => row.state === 'degraded').length,
      stoppedReason: report.stoppedReason ?? null, report: 'data/snapshots/api-smoke-report.json' }))
    if (!report.ready) process.exitCode = 1
  } catch {
    // Never print raw fetch errors, response bodies, key values or environment.
    console.error('Проверка не выполнена. Нужен выбранный ключ в защищённой переменной MM_SMOKE_ACCESS_KEY и возможность сохранить локальный отчёт.')
    process.exitCode = 1
  }
} else {
  console.error('Использование: pnpm smoke:api --plan | --run. Ключ передаётся только через защищённую переменную среды.')
  process.exitCode = 1
}
