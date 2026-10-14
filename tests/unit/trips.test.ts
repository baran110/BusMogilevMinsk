import { describe, expect, it } from 'vitest'
import { buildDemoTrips } from '../fixtures/demo'
import { chooseBestBooking, mergeExactTrips, normalizeCarrier, vehicleTypeFromName } from '../../src/lib/trips'

describe('trip normalization', () => {
  it('extracts a legal carrier and vehicle class', () => {
    expect(normalizeCarrier('MERCEDES SPRINTER 5350 ООО ВИТЭКСПРЕСС', 'АвтоСлава')).toBe('ООО Витэкспресс')
    expect(vehicleTypeFromName('Mercedes-Benz Sprinter')).toBe('minibus')
    expect(vehicleTypeFromName('МАЗ 251062')).toBe('bus')
    expect(vehicleTypeFromName('Межрегиональный поезд')).toBe('train')
  })

  it('prefers a direct available booking channel', () => {
    const trip = buildDemoTrips('mogilev-minsk', 1)[0]
    const platform = { ...trip.bookingOptions[0], sourceId: 'atlas', sourceName: 'Atlas', sourceKind: 'platform' as const, price: 20 }
    const carrier = { ...trip.bookingOptions[0], sourceId: 'carrier', sourceName: 'Перевозчик', sourceKind: 'carrier' as const, price: 25 }
    expect(chooseBestBooking([platform, carrier]).sourceId).toBe('carrier')
  })

  it('merges only exact physical duplicates', () => {
    const trip = buildDemoTrips('mogilev-minsk', 1)[0]
    const duplicate = { ...trip, id: 'duplicate', bookingOptions: [{ ...trip.bookingOptions[0], sourceId: 'second', url: 'https://example.com' }] }
    expect(mergeExactTrips([trip, duplicate])).toHaveLength(1)
    expect(mergeExactTrips([trip, { ...duplicate, departureAt: trip.departureAt.replace('05:35', '05:36') }])).toHaveLength(2)
  })
})
