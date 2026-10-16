import { addDays, isValidInstant, localDate } from './date'
import type { BookingOption, Trip, VehicleType } from '../types'

const legalPrefixes = /(ЧТУП|ООО|ОАО|ИП|ЧП)\s+[«"]?([^»"]+)/iu

export function slugify(value: string): string {
  return value
    .toLocaleLowerCase('ru')
    .replace(/[ё]/g, 'е')
    .replace(/[^a-zа-я0-9]+/giu, '-')
    .replace(/^-|-$/g, '')
}

export function normalizeCarrier(value: string, fallback: string): string {
  const match = value.match(legalPrefixes)
  if (!match) return fallback
  const company = match[2]
    .replace(/\s*\([^)]*\)\s*/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
  const titledCompany = company
    .toLocaleLowerCase('ru')
    .replace(/(^|\s|[«"])([а-яё])/giu, (_, prefix: string, letter: string) => `${prefix}${letter.toLocaleUpperCase('ru')}`)
  return `${match[1].toLocaleUpperCase('ru')} ${titledCompany}`
}

export function vehicleTypeFromName(name = ''): VehicleType {
  const normalized = name.toLocaleLowerCase('ru')
  if (/поезд|электричк|штадлер|ж\/д|железнодорож/.test(normalized)) return 'train'
  if (/sprinter|crafter|jumper|ducato|transit|боксер|микроавтобус|м\s*\/\s*а/.test(normalized)) return 'minibus'
  if (/маз|yutong|голаз|автобус|neoplan|setra/.test(normalized)) return 'bus'
  return 'unknown'
}

export function chooseBestBooking(options: BookingOption[]): BookingOption {
  if (!options.length) throw new Error('У рейса отсутствует источник бронирования')
  const rank = { available: 0, unknown: 1, sold_out: 2 }
  return [...options].sort((a, b) => {
    if (a.availability !== b.availability) return rank[a.availability] - rank[b.availability]
    if (a.sourceKind !== b.sourceKind) return a.sourceKind === 'carrier' ? -1 : 1
    return (a.price ?? Infinity) - (b.price ?? Infinity) || a.sourceId.localeCompare(b.sourceId) || a.url.localeCompare(b.url)
  })[0]
}

export const FIELD_MAX_AGE_MS = 15 * 60_000
export const SCHEDULE_MAX_AGE_MS = 7 * 24 * 60 * 60_000

export function observationAge(value: string | undefined, now: Date): number {
  if (!isValidInstant(value)) return Infinity
  const age = now.getTime() - Date.parse(value)
  return age < -60_000 ? Infinity : Math.max(0, age)
}

export function projectTrip(trip: Trip, now = new Date()): Trip | null {
  const scheduleFreshness = trip.serviceDate < addDays(localDate(now), 3) ? FIELD_MAX_AGE_MS : 75 * 60_000
  const bookingOptions = trip.bookingOptions.flatMap((option): BookingOption[] => {
    const observedAt = option.observedAt ?? trip.lastSeenAt
    if (observationAge(observedAt, now) > SCHEDULE_MAX_AGE_MS) return []
    const lastKnown = !!option.lastKnown || observationAge(observedAt, now) > scheduleFreshness
    const priceFresh = !option.lastKnown && observationAge(option.priceObservedAt, now) <= FIELD_MAX_AGE_MS
    const seatsFresh = !option.lastKnown && observationAge(option.availabilityObservedAt, now) <= FIELD_MAX_AGE_MS
    return [{ ...option, observedAt, lastKnown, price: priceFresh ? option.price : null,
      availability: seatsFresh ? option.availability : 'unknown', seats: seatsFresh ? option.seats : undefined }]
  })
  if (!bookingOptions.length) return null
  const best = chooseBestBooking(bookingOptions)
  return { ...trip, bookingOptions, price: best.price, availability: best.availability, seats: best.seats,
    lastKnown: bookingOptions.every((option) => option.lastKnown),
    lastSeenAt: bookingOptions.map((option) => option.observedAt!).sort((a, b) => Date.parse(a) - Date.parse(b)).at(-1)! }
}

export function mergeExactTrips(trips: Trip[]): Trip[] {
  const result = new Map<string, Trip>()
  for (const trip of trips) {
    const key = [
      trip.direction,
      trip.serviceDate,
      Date.parse(trip.departureAt),
      trip.arrivalAt ? Date.parse(trip.arrivalAt) : '',
      slugify(trip.carrierName),
      slugify(trip.originStop),
      slugify(trip.destinationStop),
      trip.vehicleNumber || '',
      /atlas-partner|unknown/.test(trip.carrierId) || /выбор остановки/.test(`${trip.originStop} ${trip.destinationStop}`) ? trip.id : '',
    ].join('|')
    const existing = result.get(key)
    if (!existing) {
      result.set(key, trip)
      continue
    }
    // Identical times alone do not prove that two trips sold by one source are the same vehicle.
    if (existing.id !== trip.id && existing.bookingOptions.some((a) => trip.bookingOptions.some((b) => a.sourceId === b.sourceId))) {
      result.set(`${key}|${trip.id}`, trip)
      continue
    }
    const bookingOptions = [...existing.bookingOptions]
    for (const option of trip.bookingOptions) {
      if (!bookingOptions.some((candidate) => candidate.sourceId === option.sourceId && candidate.url === option.url)) {
        bookingOptions.push(option)
      }
    }
    const best = chooseBestBooking(bookingOptions)
    result.set(key, {
      ...existing,
      id: existing.id < trip.id ? existing.id : trip.id,
      price: best.price,
      availability: best.availability,
      seats: best.seats,
      bookingOptions,
      lastSeenAt: Date.parse(existing.lastSeenAt) > Date.parse(trip.lastSeenAt) ? existing.lastSeenAt : trip.lastSeenAt,
    })
  }
  return [...result.values()].sort((a, b) => a.departureAt.localeCompare(b.departureAt))
}

export function isSnapshotStale(generatedAt: string, now = new Date()): boolean {
  return observationAge(generatedAt, now) > 20 * 60_000
}

export function isSnapshotExpired(generatedAt: string, now = new Date()): boolean {
  return observationAge(generatedAt, now) > SCHEDULE_MAX_AGE_MS
}
