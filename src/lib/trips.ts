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
  return [...options].sort((a, b) => {
    if (a.availability !== b.availability) return a.availability === 'available' ? -1 : 1
    if (a.sourceKind !== b.sourceKind) return a.sourceKind === 'carrier' ? -1 : 1
    return a.price - b.price
  })[0]
}

export function mergeExactTrips(trips: Trip[]): Trip[] {
  const result = new Map<string, Trip>()
  for (const trip of trips) {
    const key = [
      trip.direction,
      trip.serviceDate,
      trip.departureAt,
      trip.arrivalAt,
      slugify(trip.carrierName),
      slugify(trip.originStop),
      slugify(trip.destinationStop),
      trip.vehicleNumber || '',
    ].join('|')
    const existing = result.get(key)
    if (!existing) {
      result.set(key, trip)
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
      id: [existing.id, trip.id].sort().join('+'),
      price: Math.min(existing.price, trip.price),
      availability: best.availability,
      seats: Math.max(existing.seats ?? 0, trip.seats ?? 0) || undefined,
      bookingOptions,
      lastSeenAt: existing.lastSeenAt > trip.lastSeenAt ? existing.lastSeenAt : trip.lastSeenAt,
    })
  }
  return [...result.values()].sort((a, b) => a.departureAt.localeCompare(b.departureAt))
}

export function isSnapshotStale(generatedAt: string, now = new Date()): boolean {
  return now.getTime() - new Date(generatedAt).getTime() > 2 * 60 * 60 * 1000
}

export function isSnapshotExpired(generatedAt: string, now = new Date()): boolean {
  return now.getTime() - new Date(generatedAt).getTime() > 24 * 60 * 60 * 1000
}
