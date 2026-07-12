export async function fetchWithTimeout(url: string, init: RequestInit = {}, timeoutMs = 20_000): Promise<Response> {
  let lastError: unknown
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), timeoutMs)
    try {
      const response = await fetch(url, {
        ...init,
        signal: controller.signal,
        headers: {
          'User-Agent': 'MM-Routes/1.0 (+https://github.com/; public timetable aggregator)',
          'Accept-Language': 'ru-BY,ru;q=0.9',
          ...init.headers,
        },
      })
      clearTimeout(timer)
      if (!response.ok) throw new Error(`${response.status} ${response.statusText}`)
      return response
    } catch (error) {
      clearTimeout(timer)
      lastError = error
      if (attempt < 2) await new Promise((resolve) => setTimeout(resolve, 400 * 2 ** attempt))
    }
  }
  throw lastError
}
