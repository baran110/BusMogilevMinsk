import { addDays, addMinutes, localDate, minskIso } from '../../src/lib/date'
import { slugify, vehicleTypeFromName } from '../../src/lib/trips'
import type { AvailabilityStatus, Direction, Trip } from '../../src/types'
import { fetchWithTimeout } from '../lib/fetch'
import { errorResult, type SourceResult } from '../lib/source'

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

function durationMinutes(value = '03:00'): number {
  const match = value.match(/(\d{1,2}):(\d{2})/)
  if (!match) return 180
  const duration = Number(match[1]) * 60 + Number(match[2])
  return duration >= 90 && duration <= 420 ? duration : 180
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
  const departureAt = minskIso(serviceDate, raw.timeDeparture)
  const seats = Math.max(0, Number(raw.freePlaces || 0))
  const available = Boolean(raw.availableForReservation) && seats > 0
  const availability: AvailabilityStatus = available ? 'available' : 'sold_out'
  const price = Math.max(0, Number(raw.price || 0))
  const originCity = direction === 'mogilev-minsk' ? 'Могилёв' : 'Минск'
  const destinationCity = direction === 'mogilev-minsk' ? 'Минск' : 'Могилёв'
  const vehicleName = raw.transport?.trim() || 'Микроавтобус перевозчика'
  const detectedVehicleType = vehicleTypeFromName(vehicleName)
  const bookingUrl = `${config.bookingUrl}${config.bookingUrl.includes('#') ? '' : '#reservation-form-v2'}`

  return {
    id: `buspro:${config.companyId}:${raw.id}:${direction}`,
    direction,
    serviceDate,
    departureAt,
    arrivalAt: addMinutes(departureAt, duration),
    durationMinutes: duration,
    carrierId: slugify(config.name),
    carrierName: config.name,
    vehicleType: detectedVehicleType === 'unknown' ? 'minibus' : detectedVehicleType,
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
    }],
    lastSeenAt: seenAt,
  }
}

async function mapConcurrent<T, R>(items: T[], limit: number, task: (item: T) => Promise<R>): Promise<R[]> {
  const results = new Array<R>(items.length)
  let cursor = 0
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (cursor < items.length) {
      const index = cursor
      cursor += 1
      results[index] = await task(items[index])
    }
  }))
  return results
}

export async function collectBusPro(config: BusProConfig, horizonDays = 30): Promise<SourceResult> {
  const checkedAt = new Date().toISOString()
  try {
    const routesResponse = await fetchWithTimeout(`https://buspro.by/api/route?s%5Bcompany_id%5D=${config.companyId}`)
    const routes = await routesResponse.json() as BusProRoute[]
    const pairs = (['mogilev-minsk', 'minsk-mogilev'] as const).map((direction) => {
      const from = direction === 'mogilev-minsk' ? 'mogilev' : 'minsk'
      const to = direction === 'mogilev-minsk' ? 'minsk' : 'mogilev'
      const route = routes.find((candidate) => cityMatches(candidate.cityDeparture, from) && cityMatches(candidate.cityDestination, to))
      if (!route) throw new Error(`В BusPro не найден маршрут ${direction}`)
      return { direction, from: route.cityDepartureId, to: route.cityDestinationId }
    })
    const today = localDate()
    const requests = Array.from({ length: horizonDays }, (_, day) => pairs.map((pair) => ({ ...pair, date: addDays(today, day) }))).flat()
    const responses = await mapConcurrent(requests, 5, async ({ direction, from, to, date }) => {
      const query = new URLSearchParams({
        's[company_id]': String(config.companyId),
        's[city_departure_id]': String(from),
        's[city_destination_id]': String(to),
        's[date_departure]': date,
        actual: '1',
      })
      const response = await fetchWithTimeout(`https://buspro.by/api/trip?${query}`)
      const rawTrips = await response.json() as BusProTrip[]
      return rawTrips.map((trip) => normalizeBusProTrip(trip, direction, config, checkedAt))
    })
    const trips = responses.flat().filter((trip) => trip.serviceDate >= today && trip.serviceDate < addDays(today, horizonDays))
    return {
      trips,
      health: {
        id: config.id,
        name: config.name,
        kind: 'carrier',
        url: config.bookingUrl,
        status: 'ok',
        checkedAt,
        lastSuccessAt: checkedAt,
        tripsFound: trips.length,
      },
    }
  } catch (error) {
    return errorResult(config.id, config.name, 'carrier', config.bookingUrl, error)
  }
}
