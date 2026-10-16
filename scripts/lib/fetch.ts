import { sourceSignal } from './runtime'

export class HttpError extends Error {
  constructor(public readonly status: number) { super(`Источник ответил HTTP ${status}`) }
}

function pause(milliseconds: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) { reject(signal.reason); return }
    const abort = () => { clearTimeout(timer); reject(signal?.reason) }
    const timer = setTimeout(() => { signal?.removeEventListener('abort', abort); resolve() }, milliseconds)
    signal?.addEventListener('abort', abort, { once: true })
  })
}

export async function fetchWithTimeout(url: string, init: RequestInit = {}, timeoutMs = 12_000): Promise<Response> {
  const parent = [init.signal, sourceSignal()].filter((signal): signal is AbortSignal => !!signal)
  const parentSignal = parent.length ? AbortSignal.any(parent) : undefined
  let lastError: unknown
  for (let attempt = 0; attempt < 3; attempt++) {
    parentSignal?.throwIfAborted()
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(new Error('Превышено время ответа источника')), timeoutMs)
    let retryDelay = 400 * 2 ** attempt
    let retry = true
    try {
      const headers = new Headers(init.headers)
      if (!headers.has('User-Agent')) headers.set('User-Agent', 'MM-Routes/2.0 (+https://github.com/baran110/BusMogilevMinsk; timetable checks)')
      if (!headers.has('Accept-Language')) headers.set('Accept-Language', 'ru-BY,ru;q=0.9')
      const response = await fetch(url, { ...init, headers, signal: parentSignal ? AbortSignal.any([parentSignal, controller.signal]) : controller.signal })
      if (!response.ok) {
        retry = response.status === 408 || response.status >= 500
        if (response.status === 429) {
          const value = response.headers.get('Retry-After')
          retryDelay = value && /^\d+$/.test(value) ? Number(value) * 1000 : value ? Date.parse(value) - Date.now() : Infinity
          // An unknown or long rate limit ends this source's cycle; it is never bypassed.
          retry = Number.isFinite(retryDelay) && retryDelay >= 0 && retryDelay <= 10_000
        }
        await response.body?.cancel()
        throw new HttpError(response.status)
      }
      if (Number(response.headers.get('Content-Length') || 0) > 8 * 1024 * 1024) { retry = false; await response.body?.cancel(); throw new Error('Ответ источника слишком большой') }
      const reader = response.body?.getReader()
      const chunks: Uint8Array<ArrayBuffer>[] = []
      let size = 0
      if (reader) {
        try {
          while (true) {
            const { done, value } = await reader.read()
            if (done) break
            size += value.byteLength
            if (size > 8 * 1024 * 1024) { retry = false; await reader.cancel(); throw new Error('Ответ источника слишком большой') }
            chunks.push(value)
          }
        } finally { reader.releaseLock() }
      }
      const body = new Uint8Array(size)
      let offset = 0
      for (const chunk of chunks) { body.set(chunk, offset); offset += chunk.length }
      const resultHeaders = new Headers(response.headers)
      resultHeaders.delete('Content-Encoding'); resultHeaders.delete('Content-Length')
      return new Response(body, { status: response.status, statusText: response.statusText, headers: resultHeaders })
    } catch (error) {
      lastError = error
      if (parentSignal?.aborted || !retry || attempt === 2) throw error
    } finally { clearTimeout(timer) }
    await pause(retryDelay, parentSignal)
  }
  throw lastError
}
