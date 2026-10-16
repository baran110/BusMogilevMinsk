export async function checkSession(signal?: AbortSignal): Promise<boolean> {
  const response = await fetch('/api/session', { signal, credentials: 'same-origin', cache: 'no-store' })
  return response.ok
}

export async function changeSession(method: 'POST' | 'DELETE', key?: string): Promise<void> {
  const response = await fetch('/api/session', { method, credentials: 'same-origin', cache: 'no-store',
    headers: { 'Content-Type': 'application/json' }, body: method === 'POST' ? JSON.stringify({ key }) : undefined })
  if (!response.ok) {
    const body = await response.json().catch(() => null) as { error?: string } | null
    throw new Error(body?.error || 'Не удалось изменить состояние входа. Повторите попытку.')
  }
}
