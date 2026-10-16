import { describe, expect, it } from 'vitest'
import { normalizeBusProTrip } from '../../scripts/sources/buspro'
import { parseCard } from '../../scripts/sources/atlas'
import { knownNumber } from '../../scripts/lib/normalize'
import { isTrip, safeBookingUrl } from '../../src/lib/validation'
import { fixtureTrip } from '../fixtures/schedule'

describe('unknown fields and safe data', () => {
  it('does not manufacture seats, price, duration or vehicle class', () => {
    const trip = normalizeBusProTrip({ id: 1, route: 'Могилёв — Минск', dateDeparture: '15.10.2026', timeDeparture: '12:00', price: null, availableForReservation: true },
      'mogilev-minsk', { id: 'grandexpress', name: 'ГрандЭкспресс', companyId: 8, bookingUrl: 'https://grandexpress.by/' }, '2026-10-14T09:00:00Z')
    expect(trip).toMatchObject({ price: null, availability: 'unknown', durationMinutes: null, arrivalAt: null, vehicleType: 'unknown' })
    expect(trip.seats).toBeUndefined()
  })
  it('ignores cards from the previous Atlas date', () => {
    expect(parseCard('12:00\n14 окт., ср\nМогилёв\nАвтовокзал\n15:00\nМинск\nАвтовокзал\n25\nВ пути: 3 ч', 'mogilev-minsk', '2026-10-15', 0, '2026-10-14T09:00:00Z')).toBeUndefined()
  })
  it('rejects demo identifiers and unsafe or unrelated booking URLs', () => {
    const trip = fixtureTrip('2026-10-15')
    expect(isTrip({ ...trip, id: 'demo-mogilev-minsk-1' })).toBe(false)
    for (const url of ['javascript:alert(1)', 'https://avto-slava.by.evil.test/', 'http://avto-slava.by/', 'https://user:pass@avto-slava.by/', 'https://avto-slava.by:8443/']) expect(safeBookingUrl('avtoslava', url)).toBe(false)
    expect(knownNumber('25 руб.')).toBeNull()
    expect(knownNumber('25,50')).toBe(25.5)
  })
})
