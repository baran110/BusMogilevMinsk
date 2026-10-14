import type { Direction } from '../types'

export const MINSK_OFFSET = '+03:00'

export function localDate(date = new Date()): string {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Europe/Minsk',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(date)
}

export function addDays(date: string, amount: number): string {
  const value = new Date(`${date}T12:00:00Z`)
  value.setUTCDate(value.getUTCDate() + amount)
  return value.toISOString().slice(0, 10)
}

export function dateRange(start: string, days: number): string[] {
  return Array.from({ length: days }, (_, index) => addDays(start, index))
}

export function minskIso(date: string, time: string): string {
  return `${date}T${time.length === 5 ? `${time}:00` : time}${MINSK_OFFSET}`
}

export function addMinutes(iso: string, minutes: number): string {
  return new Date(new Date(iso).getTime() + minutes * 60_000).toISOString().replace('Z', '+00:00')
}

export function isDeparted(departureAt: string, now = new Date()): boolean {
  return new Date(departureAt).getTime() <= now.getTime()
}

export function formatTime(iso: string): string {
  return new Intl.DateTimeFormat('ru-RU', {
    timeZone: 'Europe/Minsk',
    hour: '2-digit',
    minute: '2-digit',
  }).format(new Date(iso))
}

export function formatDuration(minutes: number | null): string {
  if (minutes === null) return 'Время в пути не подтверждено'
  const hours = Math.floor(minutes / 60)
  const rest = minutes % 60
  return rest ? `${hours} ч ${rest} мин` : `${hours} ч`
}

export function isValidDate(value: unknown): value is string {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false
  const parsed = new Date(`${value}T12:00:00Z`)
  return Number.isFinite(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value
}

export function isValidInstant(value: unknown): value is string {
  return typeof value === 'string' && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/.test(value)
    && Number.isFinite(Date.parse(value))
}

export function formatUpdated(iso: string): string {
  return new Intl.DateTimeFormat('ru-RU', {
    timeZone: 'Europe/Minsk',
    day: '2-digit',
    month: '2-digit',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  }).format(new Date(iso))
}

export const directionCities: Record<Direction, { from: string; to: string }> = {
  'mogilev-minsk': { from: 'Могилёв', to: 'Минск' },
  'minsk-mogilev': { from: 'Минск', to: 'Могилёв' },
}

export function reverseDirection(direction: Direction): Direction {
  return direction === 'mogilev-minsk' ? 'minsk-mogilev' : 'mogilev-minsk'
}
