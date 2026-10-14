import { isTripsResponse } from './validation'
import type { Direction, TripsResponse } from '../types'

export class ApiError extends Error {
  constructor(message: string, public readonly status = 0) { super(message); this.name = 'ApiError' }
}

export async function fetchTrips(direction: Direction, date: string, signal?: AbortSignal): Promise<TripsResponse> {
  let response: Response
  try {
    response = await fetch(`/api/trips?${new URLSearchParams({ direction, date })}`, { signal, credentials: 'same-origin', cache: 'no-store' })
  } catch (error) {
    if (signal?.aborted || (error instanceof Error && error.name === 'AbortError')) throw error
    throw new ApiError('Не удалось связаться с сервисом. Проверьте подключение и повторите поиск.')
  }
  if (!response.ok) {
    const message = response.status === 401 ? 'Срок входа истёк. Введите ключ ещё раз.'
      : response.status === 400 ? 'Проверьте направление и дату поездки.'
      : 'Подтверждённое расписание сейчас недоступно. Повторите поиск позже.'
    throw new ApiError(message, response.status)
  }
  const data: unknown = await response.json().catch(() => null)
  if (!isTripsResponse(data, direction, date)) throw new ApiError('Сервис вернул некорректные данные. Повторите поиск позже.', 502)
  return data
}
