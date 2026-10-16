import { addDays, addMinutes, localDate, minskIso } from '../../src/lib/date'
import { normalizeCarrier, slugify, vehicleTypeFromName } from '../../src/lib/trips'
import type { AvailabilityStatus, Direction, SourceKind, Trip } from '../../src/types'
import { fetchWithTimeout } from '../lib/fetch'
import { errorResult, type SourceResult } from '../lib/source'
import { knownNumber, knownSeats, seatsAvailability, validatedDeparture } from '../lib/normalize'
import type { SourceCoverage } from '../../src/types'
import { throwIfSourceExpired } from '../lib/runtime'

interface TransporterConfig {
  id: string
  name: string
  baseUrl: string
  bookingUrl: string
  kind: SourceKind
  cityIds?: { mogilev: number; minsk: number }
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
  price?: string
  datetime: string
  departure_time: string
  free_seats?: number
  seats?: number
  from_station_id?: number
  to_station_id?: number
  from_route_station_id?: number
  to_route_station_id?: number
  from_city_id?: number
  to_city_id?: number
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
  const fromCityId = raw.from_city_id ?? route?.departure_city_id ?? config.cityIds?.[direction === 'mogilev-minsk' ? 'mogilev' : 'minsk'] ?? 0
  const toCityId = raw.to_city_id ?? route?.arrival_city_id ?? config.cityIds?.[direction === 'mogilev-minsk' ? 'minsk' : 'mogilev'] ?? 0
  const origin = findStation(route, [raw.from_station_id, raw.from_route_station_id].filter((value): value is number => value !== undefined), fromCityId, true)
  const destination = findStation(route, [raw.to_station_id, raw.to_route_station_id].filter((value): value is number => value !== undefined), toCityId, false)
  const measuredDuration = origin && destination ? Math.round((seconds(destination.timedelta) - seconds(origin.timedelta)) / 60) : NaN
  const durationMinutes = measuredDuration > 0 && measuredDuration <= 1440 ? measuredDuration : null
  const date = raw.datetime.slice(0, 10)
  const departureAt = validatedDeparture(date, raw.departure_time)
  const seats = knownSeats(raw.free_seats)
  const availability: AvailabilityStatus = seatsAvailability(seats)
  const carrierName = normalizeCarrier(raw.transport, config.name)
  const price = knownNumber(raw.price)
  return {
    id: `${config.id}:${raw.id}:${fromCityId}:${toCityId}`,
    direction,
    serviceDate: date,
    departureAt,
    arrivalAt: durationMinutes === null ? null : addMinutes(departureAt, durationMinutes),
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
      observedAt: seenAt,
      priceObservedAt: price === null ? undefined : seenAt,
      availabilityObservedAt: availability === 'unknown' ? undefined : seenAt,
    }],
    lastSeenAt: seenAt,
  }
}

export async function collectTransporter(config: TransporterConfig, horizonDays = 30): Promise<SourceResult> {
  const checkedAt = new Date().toISOString()
  try {
    const routeResponse = await fetchWithTimeout(`${config.baseUrl}/timetable/routes/`)
    const routePayload = await routeResponse.json() as { data?: { routes?: RawRoute[] }; result?: string }
    const routes = routePayload.data?.routes
    if (!Array.isArray(routes) || !routes.length || routePayload.result && routePayload.result !== 'success') throw new Error('Transporter: формат маршрутов изменился')
    const today = localDate()
    const cityIds = config.cityIds || { mogilev: 2, minsk: 1 }
    const requestedDates = Array.from({ length: Math.ceil(horizonDays / 3) }, (_, index) => addDays(today, index * 3 + 1))
    const all = new Map<string, Trip>()
    const coverage: SourceCoverage[] = []
    let failed = false
    for (const date of requestedDates) {
      for (const [direction, from, to] of [['mogilev-minsk', cityIds.mogilev, cityIds.minsk], ['minsk-mogilev', cityIds.minsk, cityIds.mogilev]] as const) {
        const windowDates = [-1, 0, 1].map((offset) => addDays(date, offset)).filter((day) => day >= today && day < addDays(today, horizonDays))
        try {
        if (failed) throw new Error('Остальные запросы остановлены после сбоя источника')
        throwIfSourceExpired()
        const body = new FormData()
        body.set('date', date)
        body.set('from_city', String(from))
        body.set('dest_city', String(to))
        const response = await fetchWithTimeout(`${config.baseUrl}/timetable/trips/`, { method: 'POST', body })
        const payload = await response.json() as { data?: { trips?: Record<string, RawTrip> | RawTrip[] }; result?: string }
        if (!payload.data?.trips || typeof payload.data.trips !== 'object' || payload.result && payload.result !== 'success') throw new Error('Transporter: формат рейсов изменился')
        const rawTrips = Array.isArray(payload.data.trips) ? payload.data.trips : Object.values(payload.data.trips)
        const seenAt = new Date().toISOString()
        for (const raw of rawTrips) {
          const route = routes.find((candidate) => candidate.route_id === raw.route_id)
          if ((raw.from_city_id ?? route?.departure_city_id) !== from || (raw.to_city_id ?? route?.arrival_city_id) !== to) throw new Error('Transporter вернул другое направление')
          const trip = normalizeRawTrip(raw, routes, direction, config, seenAt)
          if (trip.serviceDate < addDays(date, -1) || trip.serviceDate > addDays(date, 2)) throw new Error('Transporter вернул несогласованную дату')
          // Some providers include an extra neighbouring day. Only the requested core window is replaced.
          if (windowDates.includes(trip.serviceDate)) all.set(trip.id, trip)
        }
        coverage.push(...windowDates.map((day): SourceCoverage => ({ direction, date: day, checkedAt: seenAt, status: 'ok' })))
        } catch (error) {
          failed = true
          coverage.push(...windowDates.map((day): SourceCoverage => ({ direction, date: day, checkedAt: new Date().toISOString(), status: 'error', message: error instanceof Error ? error.message.slice(0, 180) : 'Сбой источника' })))
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
        url: config.bookingUrl,
        status: failed ? all.size ? 'stale' : 'error' : 'ok',
        checkedAt,
        lastSuccessAt: coverage.filter((item) => item.status === 'ok').map((item) => item.checkedAt).sort().at(-1),
        tripsFound: all.size,
        coverage,
        message: coverage.find((item) => item.status === 'error')?.message,
      },
    }
  } catch (error) {
    return errorResult(config.id, config.name, config.kind, config.bookingUrl, error)
  }
}
