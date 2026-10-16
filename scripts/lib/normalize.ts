import { addDays, isValidDate, minskIso } from '../../src/lib/date'
import type { AvailabilityStatus } from '../../src/types'

export function knownNumber(value: unknown): number | null {
  if (value === null || value === undefined || value === '' || typeof value === 'boolean') return null
  if (typeof value !== 'number' && (typeof value !== 'string' || !/^\d+(?:[.,]\d+)?$/.test(value.trim()))) return null
  const number = Number(typeof value === 'string' ? value.trim().replace(',', '.') : value)
  return Number.isFinite(number) && number >= 0 ? number : null
}
export function knownSeats(value: unknown): number | undefined {
  const number = knownNumber(value)
  return number !== null && Number.isInteger(number) ? number : undefined
}
export function seatsAvailability(seats: number | undefined, canReserve?: boolean): AvailabilityStatus {
  return seats === 0 ? 'sold_out' : seats !== undefined && canReserve !== false ? 'available' : 'unknown'
}
export function validatedDeparture(date: string, time: string): string {
  if (!isValidDate(date) || !/^(?:[01]\d|2[0-3]):[0-5]\d(?::[0-5]\d)?$/.test(time)) throw new Error('Источник вернул неверную дату или время')
  return minskIso(date, time)
}
export function arrivalFromClock(date: string, departureAt: string, time: string): string | null {
  if (!/^(?:[01]\d|2[0-3]):[0-5]\d$/.test(time)) return null
  let arrivalAt = minskIso(date, time)
  if (Date.parse(arrivalAt) <= Date.parse(departureAt)) arrivalAt = minskIso(addDays(date, 1), time)
  return arrivalAt
}
