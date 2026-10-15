import { localDate } from '../../src/lib/date'
import { collectBzd } from '../sources/bzd'
import { bzdBatches, bzdBatchPairs, BZD_SOURCE, createBzdStage, type BzdBatch, type BzdStage } from './bzd-stage'
import { completeFailedCoverage } from './coverage'
import { withSourceDeadline } from './runtime'
import { errorResult, type SourceResult } from './source'

interface BatchIO {
  read: (batch: BzdBatch) => Promise<unknown>
  write: (stage: BzdStage) => Promise<void>
  collect?: typeof collectBzd
  now?: () => Date
  completed?: (stage: BzdStage) => void
  /** Bounded read-only diagnosis of one far package; production always collects all. */
  part?: number
}

export async function collectBzdBatches(scope: BzdBatch['scope'], io: BatchIO): Promise<boolean> {
  const clock = io.now ?? (() => new Date())
  if (io.part !== undefined && (scope !== 'far' || !Number.isInteger(io.part) || io.part < 0 || io.part > 5)) throw new Error('Неверный диагностический пакет')
  const batches = bzdBatches(scope, localDate(clock())).filter((batch) => io.part === undefined || batch.part === io.part)
  const deadline = clock().getTime() + (scope === 'near' ? 160_000 : io.part === undefined ? 45 * 60000 : 10 * 60000)
  let halted = false
  let allSuccessful = true
  for (const batch of batches) {
    const previous = await io.read(batch)
    const pairs = bzdBatchPairs(batch)
    let result: SourceResult
    const remaining = deadline - clock().getTime()
    try {
      if (halted || remaining <= 0) throw new Error('Запросы БЖД остановлены до следующего цикла')
      result = await withSourceDeadline(remaining, () => (io.collect ?? collectBzd)(30, pairs, scope === 'near' ? 2 : 1))
      halted = result.halted === true
    } catch (error) {
      halted = true
      result = errorResult(BZD_SOURCE.id, BZD_SOURCE.name, BZD_SOURCE.kind, BZD_SOURCE.url, error, clock())
    }
    result = completeFailedCoverage(result, pairs)
    allSuccessful &&= result.health.status === 'ok'
    const stage = createBzdStage(batch, result, previous, clock())
    // Each package is durable immediately. No active manifest is written here.
    await io.write(stage)
    io.completed?.(stage)
  }
  return allSuccessful
}
