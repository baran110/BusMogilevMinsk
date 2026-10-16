// Explicit local e2e API, backed by fixture KV and the actual production request handlers.
// Loaded only by Vite's dev server when E2E_FIXTURES=1. No Cloudflare writes or external collection.
import type { Plugin } from 'vite'
import { handleProtectedTrips } from '../../functions/api/_service'
import { handleSessionRequest } from '../../functions/api/_auth'
import { fixtureKv, fixtureTrip, testAuthEnv } from '../fixtures/schedule'
import type { DirectionSnapshot } from '../../src/types'

export function fixtureApi(): Plugin {
  return { name: 'explicit-e2e-fixture-api', configureServer(server) {
    server.middlewares.use(async (incoming, outgoing, next) => {
      if (!incoming.url?.startsWith('/api/')) return next()
      try {
        const chunks: Buffer[] = []
        for await (const chunk of incoming) chunks.push(Buffer.from(chunk))
        const url = new URL(incoming.url, `http://${incoming.headers.host}`)
        const headers = new Headers()
        for (const [name, value] of Object.entries(incoming.headers)) if (value) headers.set(name, Array.isArray(value) ? value.join(',') : value)
        const method = incoming.method || 'GET'
        const request = new Request(url, { method, headers, body: ['GET', 'HEAD'].includes(method) ? undefined : Buffer.concat(chunks) })
        const env = await testAuthEnv()
        const date = url.searchParams.get('date') || '2026-10-15'
        const kv = fixtureKv(date)
        const original = kv.get.bind(kv)
        kv.get = async <T>(key: string, type: 'json') => {
          const value = await original<T>(key, type)
          if (key === 'out' || key === 'back') {
            const snapshot = value as DirectionSnapshot
            const train = fixtureTrip(date, snapshot.direction)
            train.id += ':train'; train.carrierName = 'Тестовый поезд'; train.vehicleType = 'train'; train.price = 150
            train.bookingOptions[0].price = 150
            const bus = fixtureTrip(date, snapshot.direction)
            bus.id += ':bus'; bus.carrierName = 'Тестовый автобус'; bus.vehicleType = 'bus'; bus.price = null; bus.availability = 'unknown'; bus.seats = undefined
            bus.bookingOptions[0].price = null; bus.bookingOptions[0].availability = 'unknown'; bus.bookingOptions[0].seats = undefined
            return { ...snapshot, trips: [...snapshot.trips, train, bus] } as T
          }
          return value
        }
        const response = url.pathname === '/api/session' ? await handleSessionRequest(request, env)
          : url.pathname === '/api/trips' ? await handleProtectedTrips(request, { ...env, TRIPS_KV: kv }) : new Response('{}', { status: 404 })
        outgoing.statusCode = response.status
        response.headers.forEach((value, name) => outgoing.setHeader(name, value))
        outgoing.end(await response.text())
      } catch { outgoing.statusCode = 500; outgoing.end('{}') }
    })
  } }
}
