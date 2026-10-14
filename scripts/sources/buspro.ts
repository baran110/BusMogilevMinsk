import { addDays, addMinutes, localDate, minskIso } from '../../src/lib/date'
import { slugify, vehicleTypeFromName } from '../../src/lib/trips'
import type { AvailabilityStatus, Direction, Trip } from '../../src/types'
import { fetchWithTimeout } from '../lib/fetch'
import { errorResult, type SourceResult } from '../lib/source'
import { collectPairs, requestedPairs } from '../lib/coverage'
import { knownNumber, knownSeats, seatsAvailability, validatedDeparture } from '../lib/normalize'

export interface BusProConfig {
  id: string
  name: string
  companyId: number
  bookingUrl: string
}

interface BusProRoute {
  id: number
  cityDeparture: string
  cityDestination: string
  cityDepartureId: number
  cityDestinationId: number
}

interface BusProStop {
  id: number
  name: string
  time?: string
}

interface BusProTrip {
  id: number
  route: string
  transport?: string
  dateDeparture: string
  timeDeparture: string
  price: number | string | null
  travelTime?: string
  availableForReservation?: number | boolean
  freePlaces?: number
  allPlaces?: number
  status?: number
  stays?: BusProStop[]
  finishStays?: BusProStop[] | null
}

function cityMatches(value: string, city: 'mogilev' | 'minsk'): boolean {
  const normalized = value.toLocaleLowerCase('ru').replace(/ё/g, 'е')
  return city === 'mogilev' ? normalized.includes('могилев') : normalized.includes('минск')
}

function isoDate(value: string): string {
  const match = value.match(/^(\d{2})\.(\d{2})\.(\d{4})$/)
  return match ? `${match[3]}-${match[2]}-${match[1]}` : value.slice(0, 10)
}

function durationMinutes(value = ''): number | null {
  const match = value.match(/^(\d{1,2}):([0-5]\d)$/)
  if (!match) return null
  const duration = Number(match[1]) * 60 + Number(match[2])
  return duration > 0 && duration <= 1440 ? duration : null
}

function vehicleNumber(value = ''): string | undefined {
  return value.match(/\(([^)]*\d[^)]*)\)/u)?.[1]?.trim()
}

function displayStop(stops: BusProStop[] | null | undefined, time: string, city: string): string {
  const exact = stops?.find((stop) => stop.time === time)
  if (exact?.name) return exact.name
  if (stops?.length === 1) return stops[0].name
  return stops?.length ? `${city} · выбор остановки` : city
}

export function normalizeBusProTrip(raw: BusProTrip, direction: Direction, config: BusProConfig, seenAt: string): Trip {
  const serviceDate = isoDate(raw.dateDeparture)
  const duration = durationMinutes(raw.travelTime)
  const departureAt = validatedDeparture(serviceDate, raw.timeDeparture)
  const seats = knownSeats(raw.freePlaces)
  const canReserve = raw.availableForReservation === undefined ? undefined : raw.availableForReservation === true || raw.availableForReservation === 1
  const availability: AvailabilityStatus = seatsAvailability(seats, canReserve)
  const price = knownNumber(raw.price)
  const originCity = direction === 'mogilev-minsk' ? 'Могилёв' : 'Минск'
  const destinationCity = direction === 'mogilev-minsk' ? 'Минск' : 'Могилёв'
  const vehicleName = raw.transport?.trim() || 'Транспорт перевозчика'
  const detectedVehicleType = vehicleTypeFromName(vehicleName)
  const bookingUrl = `${config.bookingUrl}${config.bookingUrl.includes('#') ? '' : '#reservation-form-v2'}`

  return {
    id: `buspro:${config.companyId}:${raw.id}:${direction}`,
    direction,
    serviceDate,
    departureAt,
    arrivalAt: duration === null ? null : addMinutes(departureAt, duration),
    durationMinutes: duration,
    carrierId: slugify(config.name),
    carrierName: config.name,
    vehicleType: detectedVehicleType,
    vehicleName,
    vehicleNumber: vehicleNumber(vehicleName),
    routeNumber: raw.route,
    originStop: displayStop(raw.stays, raw.timeDeparture, originCity),
    destinationStop: raw.finishStays?.[0]?.name || destinationCity,
    price,
    currency: 'BYN',
    availability,
    seats,
    bookingOptions: [{
      sourceId: config.id,
      sourceName: config.name,
      sourceKind: 'carrier',
      url: bookingUrl,
      price,
      currency: 'BYN',
      availability,
      seats,
      observedAt: seenAt,
      priceObservedAt: price === null ? undefined : seenAt,
      availabilityObservedAt: availability === 'unknown' ? undefined : seenAt,
    }],
    lastSeenAt: seenAt,
  }
}

export async function collectBusPro(config: BusProConfig, horizonDays = 30): Promise<SourceResult> {
  try {
    const routesResponse = await fetchWithTimeout(`https://buspro.by/api/route?s%5Bcompany_id%5D=${config.companyId}`)
    const routes: unknown = await routesResponse.json()
    if (!Array.isArray(routes) || !routes.every((route) => typeof route.cityDeparture === 'string' && typeof route.cityDestination === 'string' && Number.isInteger(route.cityDepartureId) && Number.isInteger(route.cityDestinationId))) throw new Error('BusPro: формат маршрутов изменился')
    return await collectPairs({ id: config.id, name: config.name, kind: 'carrier', url: config.bookingUrl }, requestedPairs(horizonDays), async (direction, date) => {
      const from = direction === 'mogilev-minsk' ? 'mogilev' : 'minsk'
      const to = direction === 'mogilev-minsk' ? 'minsk' : 'mogilev'
      const route = (routes as BusProRoute[]).find((candidate) => cityMatches(candidate.cityDeparture, from) && cityMatches(candidate.cityDestination, to))
      if (!route) throw new Error(`В BusPro не найден маршрут ${direction}`)
      const query = new URLSearchParams({ 's[company_id]': String(config.companyId), 's[city_departure_id]': String(route.cityDepartureId), 's[city_destination_id]': String(route.cityDestinationId), 's[date_departure]': date, actual: '1' })
      const response = await fetchWithTimeout(`https://buspro.by/api/trip?${query}`)
      const rawTrips: unknown = await response.json()
      if (!Array.isArray(rawTrips)) throw new Error('BusPro: формат рейсов изменился')
      const seenAt = new Date().toISOString()
      return (rawTrips as BusProTrip[]).map((trip) => normalizeBusProTrip(trip, direction, config, seenAt))
    })
  } catch (error) { return errorResult(config.id, config.name, 'carrier', config.bookingUrl, error) }
}
