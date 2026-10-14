import { describe, expect, it } from 'vitest'
import { dateFromCalendarLabel, parseCard } from '../../scripts/sources/atlas'

describe('Atlas adapter', () => {
  it('uses the explicit next-day arrival to prove a date omitted from a current-day departure', () => {
    const text = ['22:30', 'Минск', 'Тестовая остановка отправления', '01:30', '15 окт., чт', 'Могилёв', 'Тестовая остановка прибытия', '35', 'свободно 2 места', 'Mercedes Sprinter', 'В пути: 3 ч'].join('\n')
    const trip = parseCard(text, 'minsk-mogilev', '2026-10-14', 0, '2026-10-14T19:00:00Z')
    expect(trip).toMatchObject({ serviceDate: '2026-10-14', durationMinutes: 180, originStop: 'Тестовая остановка отправления', destinationStop: 'Тестовая остановка прибытия' })
    expect(trip?.arrivalAt).toBe('2026-10-15T01:30:00+03:00')
    expect(parseCard(text, 'minsk-mogilev', '2026-10-15', 0, '2026-10-14T19:00:00Z')).toBeUndefined()
  })
  it('parses calendar dates across a year boundary', () => {
    expect(dateFromCalendarLabel('31 дек., чт от 25', '2026-12-20')).toBe('2026-12-31')
    expect(dateFromCalendarLabel('2 янв., сб от 25', '2026-12-20')).toBe('2027-01-02')
  })

  it('parses a public trip card including stops, seats and price', () => {
    const trip = parseCard([
      '04:20',
      '13 июл., пн',
      'Могилёв',
      'Автовокзал (Платформа №2)',
      '07:20',
      'Минск',
      'Кирова 8 корп 2 (парковка)',
      '35 ',
      'Только наличными',
      'за 1 место',
      'свободно 2 места',
      'Заказать',
      'Показать детали',
      'Mercedes-Benz, Sprinter',
      'В пути: 3 ч',
    ].join('\n'), 'mogilev-minsk', '2026-07-13', 0, '2026-07-12T20:00:00.000Z')

    expect(trip).toMatchObject({
      serviceDate: '2026-07-13',
      originStop: 'Автовокзал (Платформа №2)',
      destinationStop: 'Кирова 8 корп 2 (парковка)',
      price: 35,
      seats: 2,
      availability: 'available',
      vehicleType: 'minibus',
    })
  })
})
