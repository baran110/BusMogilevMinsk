import { afterEach, describe, expect, it, vi } from 'vitest'
import { collectTransporter } from '../../scripts/sources/transporter'

const routePayload = {
  data: {
    routes: [{
      route_id: 7,
      departure_city_id: 2,
      arrival_city_id: 1,
      stations_all__ordered: [
        { id: 10, station_id: 10, station__title: 'Автовокзал Могилёв', city_id: 2, city__title: 'Могилёв', timedelta: '00:00:00', sequence: 1 },
        { id: 20, station_id: 20, station__title: 'Минск Центральный', city_id: 1, city__title: 'Минск', timedelta: '03:00:00', sequence: 2 },
      ],
    }],
  },
}

afterEach(() => vi.unstubAllGlobals())

describe('transporter API adapter', () => {
  it.each(['date', 'direction'] as const)('discards the entire response after an invalid %s, retaining earlier confirmed responses', async (invalidField) => {
    vi.stubGlobal('fetch', vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      if (String(input).endsWith('/timetable/routes/')) return new Response(JSON.stringify(routePayload))
      const form = init?.body as FormData
      const from = Number(form.get('from_city'))
      const to = Number(form.get('dest_city'))
      const date = String(form.get('date'))
      const valid = { id: `valid-${from}`, route_id: 7, route: 'Маршрут', transport: 'MERCEDES SPRINTER',
        datetime: `${date}T09:10:00`, departure_time: '09:10', from_city_id: from, to_city_id: to }
      const invalid = { ...valid, id: 'invalid', ...(invalidField === 'date'
        ? { datetime: '2000-01-01T09:10:00' } : { from_city_id: to, to_city_id: from }) }
      return new Response(JSON.stringify({ data: { trips: from === 2 ? [valid] : [valid, invalid] } }))
    }))

    const result = await collectTransporter({ id: 'test', name: 'Источник', baseUrl: 'https://example.com',
      bookingUrl: 'https://example.com', kind: 'carrier' }, 3)

    expect(result.health.status).toBe('stale')
    expect(result.trips.map((trip) => trip.id)).toEqual(['test:valid-2:2:1'])
    expect(result.health.coverage?.filter((item) => item.status === 'ok')).toHaveLength(1)
    expect(result.health.coverage?.filter((item) => item.status === 'error')).toHaveLength(5)
    expect(result.health.coverage?.filter((item) => item.direction === 'minsk-mogilev').every((item) => item.status === 'error')).toBe(true)
  })

  it('requests each date separately and accepts only that date from neighbouring-day envelopes', async () => {
    const requests: Array<{ date: string; from: number }> = []
    vi.stubGlobal('fetch', vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      if (String(input).endsWith('/timetable/routes/')) return new Response(JSON.stringify(routePayload))
      const form = init?.body as FormData
      const date = String(form.get('date'))
      const from = Number(form.get('from_city'))
      const to = Number(form.get('dest_city'))
      requests.push({ date, from })
      const trips = [-2, -1, 0, 1, 2].map((offset) => {
        const value = new Date(`${date}T12:00:00Z`)
        value.setUTCDate(value.getUTCDate() + offset)
        const serviceDate = value.toISOString().slice(0, 10)
        return { id: `${serviceDate}-${from}`, route_id: 7, route: 'Маршрут', transport: 'MERCEDES SPRINTER',
          datetime: `${serviceDate}T09:10:00`, departure_time: '09:10', from_city_id: from, to_city_id: to }
      })
      return new Response(JSON.stringify({ data: { trips } }))
    }))

    const result = await collectTransporter({ id: 'test', name: 'Источник', baseUrl: 'https://example.com',
      bookingUrl: 'https://example.com', kind: 'carrier' }, 3)

    expect(requests).toHaveLength(6)
    expect(new Set(requests.map((request) => request.date)).size).toBe(3)
    expect(result.health.status).toBe('ok')
    expect(result.trips).toHaveLength(6)
    expect(result.health.coverage).toHaveLength(6)
    for (const item of result.health.coverage ?? []) {
      expect(requests).toContainEqual({ date: item.date, from: item.direction === 'mogilev-minsk' ? 2 : 1 })
      expect(item.status).toBe('ok')
    }
    expect(new Set(result.trips.map((trip) => trip.serviceDate))).toEqual(new Set(requests.map((request) => request.date)))
  })

  it('does not confirm an empty selected date from a nonempty response containing only another date', async () => {
    vi.stubGlobal('fetch', vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      if (String(input).endsWith('/timetable/routes/')) return new Response(JSON.stringify(routePayload))
      const form = init?.body as FormData
      const date = new Date(`${String(form.get('date'))}T12:00:00Z`)
      date.setUTCDate(date.getUTCDate() - 1)
      return new Response(JSON.stringify({ data: { trips: [{ id: 'other-day', route_id: 7, route: 'Маршрут',
        transport: 'MERCEDES SPRINTER', datetime: `${date.toISOString().slice(0, 10)}T09:10:00`, departure_time: '09:10',
        from_city_id: Number(form.get('from_city')), to_city_id: Number(form.get('dest_city')) }] } }))
    }))

    const result = await collectTransporter({ id: 'test', name: 'Источник', baseUrl: 'https://example.com',
      bookingUrl: 'https://example.com', kind: 'carrier' }, 3)

    expect(result.trips).toEqual([])
    expect(result.health.status).toBe('error')
    expect(result.health.coverage).toHaveLength(6)
    expect(result.health.coverage?.every((item) => item.status === 'error')).toBe(true)
  })

  it.each([false, true])('filters other routes without claiming their time, price or empty coverage (only other route: %s)', async (onlyOtherRoute) => {
    vi.stubGlobal('fetch', vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      if (String(input).endsWith('/timetable/routes/')) return new Response(JSON.stringify({ data: { routes: [
        ...routePayload.data.routes, { route_id: 38, departure_city_id: 21, arrival_city_id: 1 },
      ] } }))
      const form = init?.body as FormData
      const date = String(form.get('date'))
      const direct = { id: `direct-${form.get('from_city')}`, route_id: 7, route: 'Прямой маршрут', transport: 'MERCEDES SPRINTER',
        datetime: `${date}T09:10:00`, departure_time: '09:10', from_city_id: Number(form.get('from_city')), to_city_id: Number(form.get('dest_city')) }
      const other = { id: 'other-route', route_id: 38, route: 'Другой маршрут', transport: 'MERCEDES SPRINTER',
        datetime: `${date}T05:50:00`, departure_time: '05:50', price: '99' }
      return new Response(JSON.stringify({ data: { trips: onlyOtherRoute ? [other] : [direct, other] } }))
    }))

    const result = await collectTransporter({ id: 'test', name: 'Источник', baseUrl: 'https://example.com',
      bookingUrl: 'https://example.com', kind: 'carrier' }, 1)

    expect(result.health.status).toBe(onlyOtherRoute ? 'error' : 'ok')
    expect(result.trips).toHaveLength(onlyOtherRoute ? 0 : 2)
    expect(result.trips.every((trip) => trip.routeNumber === '7')).toBe(true)
    expect(result.health.coverage?.every((item) => item.status === (onlyOtherRoute ? 'error' : 'ok'))).toBe(true)
  })

  it('converts a public timetable response to Trip', async () => {
    vi.stubGlobal('fetch', vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input)
      if (url.endsWith('/timetable/routes/')) return new Response(JSON.stringify(routePayload), { status: 200 })
      const form = init?.body as FormData
      const from = Number(form.get('from_city'))
      const date = String(form.get('date'))
      const raw = from === 2 ? {
        id: '123', route_id: 7, route: 'Могилёв -> Минск', transport: 'MERCEDES SPRINTER 5350 ООО ВИТЭКСПРЕСС', price: '25.00',
        datetime: `${date}T09:10:00`, departure_time: '09:10', free_seats: 3, seats: 3, from_station_id: 10, to_station_id: 20,
        from_route_station_id: 10, to_route_station_id: 20, from_city_id: 2, to_city_id: 1,
      } : undefined
      return new Response(JSON.stringify({ data: { trips: raw ? { one: raw } : {} } }), { status: 200 })
    }))
    const result = await collectTransporter({ id: 'test', name: 'Источник', baseUrl: 'https://example.com', bookingUrl: 'https://example.com', kind: 'carrier' }, 2)
    expect(result.health.status).toBe('ok')
    expect(result.trips).toHaveLength(1)
    expect(result.trips[0]).toMatchObject({ carrierName: 'ООО Витэкспресс', durationMinutes: 180, price: 25, seats: 3 })
  })

  it('supports provider-specific city ids and trips without duplicated city fields', async () => {
    const routes = {
      data: {
        routes: [{
          route_id: 26,
          departure_city_id: 15,
          arrival_city_id: 18,
          stations_all__ordered: [
            { id: 144, station_id: 144, station__title: 'Могилев - Автовокзал', city_id: 15, city__title: 'Могилёв', timedelta: '00:00:00', sequence: 1 },
            { id: 143, station_id: 143, station__title: 'Минск - Автовокзал Центральный', city_id: 18, city__title: 'Минск', timedelta: '03:00:00', sequence: 2 },
          ],
        }],
      },
    }
    vi.stubGlobal('fetch', vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      if (String(input).endsWith('/timetable/routes/')) return new Response(JSON.stringify(routes), { status: 200 })
      const form = init?.body as FormData
      const forward = form.get('from_city') === '15' && form.get('dest_city') === '18'
      const date = String(form.get('date'))
      const raw = forward ? {
        id: '64451', route_id: 26, route: 'Могилев - Минск', transport: 'MERCEDES SPRINTER 8666', price: '25.00',
        datetime: `${date}T06:25:00`, departure_time: '06:25', free_seats: 15, seats: 15,
      } : undefined
      return new Response(JSON.stringify({ data: { trips: raw ? { one: raw } : {} } }), { status: 200 })
    }))

    const result = await collectTransporter({
      id: 'vitexpress',
      name: 'ВитЭкспресс',
      baseUrl: 'https://vitexpress.driveprof.com',
      bookingUrl: 'https://vitexpress.by/online-bron',
      kind: 'carrier',
      cityIds: { mogilev: 15, minsk: 18 },
    }, 2)

    expect(result.trips).toHaveLength(1)
    expect(result.trips[0]).toMatchObject({
      direction: 'mogilev-minsk',
      originStop: 'Могилев - Автовокзал',
      destinationStop: 'Минск - Автовокзал Центральный',
      carrierName: 'ВитЭкспресс',
      seats: 15,
    })
  })
})
