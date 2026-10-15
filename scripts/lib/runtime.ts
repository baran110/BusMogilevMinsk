import { AsyncLocalStorage } from 'node:async_hooks'

const context = new AsyncLocalStorage<AbortSignal>()
export function collectionDeadline(sourceId: string, mode: 'near' | 'full'): number {
  return mode === 'full' ? 360_000 : sourceId === 'bzd' ? 160_000 : 90_000
}
export function sourceSignal(): AbortSignal | undefined { return context.getStore() }
export async function withSourceDeadline<T>(milliseconds: number, operation: () => Promise<T>): Promise<T> {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(new Error('Источник превысил допустимое время проверки')), milliseconds)
  try { return await context.run(controller.signal, operation) } finally { clearTimeout(timer) }
}
export function throwIfSourceExpired(): void { sourceSignal()?.throwIfAborted() }

export async function mapConcurrent<T, R>(items: T[], limit: number, operation: (item: T) => Promise<R>): Promise<R[]> {
  const results = new Array<R>(items.length)
  let cursor = 0
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (cursor < items.length) {
      const index = cursor++
      results[index] = await operation(items[index])
    }
  }))
  return results
}
