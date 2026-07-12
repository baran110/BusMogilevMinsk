import { describe, expect, it } from 'vitest'
import { normalizeBusProTrip } from '../../scripts/sources/buspro'

describe('BusPro adapter', () => {
  it('normalizes a carrier trip with stops, price and seats', () => {
    const trip = normalizeBusProTrip({
      id: 42,
      route: 'Могилёв - Минск',
      transport: 'Белый м/а КОНДИЦИОНЕР (4500 АК-6)',
      dateDeparture: '13.07.2026',
      timeDeparture: '07:30',
      price: 25,
      travelTime: '02:20',
      availableForReservation: 1,
      freePlaces: 4,
      allPlaces: 15,
      stays: [{ id: 1, name: 'Автовокзал', time: '07:30' }],
      finishStays: [{ id: 2, name: 'АВ Центральный' }],
    }, 'mogilev-minsk', { id: 'grandexpress', name: 'ГрандЭкспресс', companyId: 8, bookingUrl: 'https://grandexpress.by/' }, '2026-07-12T12:00:00Z')

    expect(trip).toMatchObject({
      serviceDate: '2026-07-13',
      durationMinutes: 140,
      vehicleType: 'minibus',
      originStop: 'Автовокзал',
      destinationStop: 'АВ Центральный',
      price: 25,
      seats: 4,
      availability: 'available',
    })
  })
})
