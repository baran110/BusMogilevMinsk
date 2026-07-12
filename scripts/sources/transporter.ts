import { addDays, addMinutes, localDate, minskIso } from '../../src/lib/date'
import { normalizeCarrier, slugify, vehicleTypeFromName } from '../../src/lib/trips'
import type { AvailabilityStatus, Direction, SourceKind, Trip } from '../../src/types'
import { fetchWithTimeout } from '../lib/fetch'
import { errorResult, type SourceResult } from '../lib/source'

interface TransporterConfig {
  id: string
  name: string
  baseUrl: string
  bookingUrl: string
  kind: SourceKind
}

interface RawStation {
  id: number
  station_id: number
  station__title: string
  city_id: number
  city__title: string
  timedelta: string
  sequence: number
}

interface RawRoute {
  route_id: number
  departure_city_id: number
  arrival_city_id: number
  stations_all__ordered?: RawStation[]
  stations_all?: Record<string, RawStation>
}

interface RawTrip {
  id: string
  route_id: number
  route: string
  transport: string
  price: string
  datetime: string
  departure_time: string
  free_seats: number
  seats: number
  from_station_id: number
  to_station_id: number
  from_route_station_id: number
  to_route_station_id: number
  from_city_id: number
  to_city_id: number
}

function seconds(value = '00:00:00'): number {
  const [hours, minutes, secs] = value.split(':').map(Number)
  return hours * 3600 + minutes * 60 + secs
}

function findStation(route: RawRoute | undefined, values: number[], cityId: number, first: boolean): RawStation | undefined {
  const stations = route?.stations_all__ordered || Object.values(route?.stations_all || {}).sort((a, b) => a.sequence - b.sequence)
  if (!stations?.length) return undefined
  const exact = stations.find((station) => values.includes(station.id) || values.includes(station.station_id))
  if (exact) return exact
  const inCity = stations.filter((station) => station.city_id === cityId)
  return first ? inCity[0] : inCity.at(-1)
}

function vehicleNumber(value: string): string | undefined {
  return value.match(/\b(?:[A-ZА-Я]{1,2}\s*)?\d{3,4}(?:-\d)?\b/u)?.[0]?.replace(/\s+/g, ' ')
}

function normalizeRawTrip(raw: RawTrip, routes: RawRoute[], direction: Direction, config: TransporterConfig, seenAt: string): Trip {
  const route = routes.find((candidate) => candidate.route_id === raw.route_id)
  const origin = findStation(route, [raw.from_station_id, raw.from_route_station_id], raw.from_city_id, true)
  const destination = findStation(route, [raw.to_station_id, raw.to_route_station_id], raw.to_city_id, false)
  let durationMinutes = origin && destination ? Math.round((seconds(destination.timedelta) - seconds(origin.timedelta)) / 60) : 0
  if (durationMinutes <= 0) durationMinutes += durationMinutes < -60 ? 24 * 60 : 180
  if (durationMinutes < 120 || durationMinutes > 300) durationMinutes = 180
  const date = raw.datetime.slice(0, 10)
  const departureAt = minskIso(date, raw.departure_time)
  const seats = Math.max(0, Number(raw.free_seats ?? raw.seats ?? 0))
  const availability: AvailabilityStatus = seats > 0 ? 'available' : 'sold_out'
  const carrierName = normalizeCarrier(raw.transport, config.name)
  const price = Number.parseFloat(raw.price) || 0
  return {
    id: `${config.id}:${raw.id}:${raw.from_city_id}:${raw.to_city_id}`,
    direction,
    serviceDate: date,
    departureAt,
    arrivalAt: addMinutes(departureAt, durationMinutes),
    durationMinutes,
    carrierId: slugify(carrierName),
    carrierName,
    vehicleType: vehicleTypeFromName(raw.transport),
    vehicleName: raw.transport.replace(/\s+(ЧТУП|ООО|ОАО|ИП|ЧП)\s+.*/iu, '').trim(),
    vehicleNumber: vehicleNumber(raw.transport),
    routeNumber: String(raw.route_id),
    originStop: origin?.station__title || (direction === 'mogilev-minsk' ? 'Могилёв' : 'Минск'),
    destinationStop: destination?.station__title || (direction === 'mogilev-minsk' ? 'Минск' : 'Могилёв'),
    price,
    currency: 'BYN',
    availability,
    seats,
    bookingOptions: [{
      sourceId: config.id,
      sourceName: config.name,
      sourceKind: config.kind,
      url: config.bookingUrl,
      price,
      currency: 'BYN',
      availability,
      seats,
    }],
    lastSeenAt: seenAt,
  }
}

export async function collectTransporter(config: TransporterConfig, horizonDays = 30): Promise<SourceResult> {
  const checkedAt = new Date().toISOString()
  try {
    const routeResponse = await fetchWithTimeout(`${config.baseUrl}/timetable/routes/`)
    const routePayload = await routeResponse.json() as { data?: { routes?: RawRoute[] } }
    const routes = routePayload.data?.routes || []
    const today = localDate()
    const requestedDates = Array.from({ length: Math.ceil(horizonDays / 3) }, (_, index) => addDays(today, index * 3 + 1))
    const all = new Map<string, Trip>()
    for (const date of requestedDates) {
      for (const [direction, from, to] of [['mogilev-minsk', 2, 1], ['minsk-mogilev', 1, 2]] as const) {
        const body = new FormData()
        body.set('date', date)
        body.set('from_city', String(from))
        body.set('dest_city', String(to))
        const response = await fetchWithTimeout(`${config.baseUrl}/timetable/trips/`, { method: 'POST', body })
        const payload = await response.json() as { data?: { trips?: Record<string, RawTrip> | RawTrip[] } }
        const rawTrips = Array.isArray(payload.data?.trips) ? payload.data.trips : Object.values(payload.data?.trips || {})
        for (const raw of rawTrips) {
          const trip = normalizeRawTrip(raw, routes, direction, config, checkedAt)
          if (trip.serviceDate >= today && trip.serviceDate < addDays(today, horizonDays)) all.set(trip.id, trip)
        }
      }
      await new Promise((resolve) => setTimeout(resolve, 120))
    }
    return {
      trips: [...all.values()],
      health: {
        id: config.id,
        name: config.name,
        kind: config.kind,
        url: config.baseUrl,
        status: 'ok',
        checkedAt,
        lastSuccessAt: checkedAt,
        tripsFound: all.size,
      },
    }
  } catch (error) {
    return errorResult(config.id, config.name, config.kind, config.baseUrl, error)
  }
}
