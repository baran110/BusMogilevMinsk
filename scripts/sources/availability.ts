import { fetchWithTimeout } from '../lib/fetch'
import { errorResult, type SourceResult } from '../lib/source'

export async function checkSource(id: string, name: string, kind: 'carrier' | 'platform', url: string, message = 'Источник доступен, но маршрут не подтверждён публичным API'):
Promise<SourceResult> {
  const checkedAt = new Date().toISOString()
  try {
    await fetchWithTimeout(url, {}, 30_000)
    return { trips: [], health: { id, name, kind, url, status: 'unchecked', checkedAt, tripsFound: 0, message } }
  } catch (error) {
    return errorResult(id, name, kind, url, error)
  }
}
