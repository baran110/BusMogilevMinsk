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
