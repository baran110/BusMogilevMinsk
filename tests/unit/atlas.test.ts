import { describe, expect, it } from 'vitest'
import { dateFromCalendarLabel, parseCard } from '../../scripts/sources/atlas'

describe('Atlas adapter', () => {
  it.each(['В пути: 3 ч', 'В пути 3 ч'])('accepts %s in date-free current-day cards only with a matching selected calendar tab', (duration) => {
    const text = ['17:30', 'Могилёв', 'Тестовая остановка отправления', '20:30', 'Минск', 'Тестовая остановка прибытия', '35', duration].join('\n')
    const seenAt = '2026-10-15T12:00:00Z'
    const calendar = { label: '15 окт., чт\nот 25', selected: true }
    expect(parseCard(text, 'mogilev-minsk', '2026-10-15', 0, seenAt, calendar)).toMatchObject({ serviceDate: '2026-10-15', durationMinutes: 180 })
    expect(parseCard(text, 'mogilev-minsk', '2026-10-15', 0, seenAt)).toBeUndefined()
    expect(parseCard(text, 'mogilev-minsk', '2026-10-15', 0, seenAt, { ...calendar, selected: false })).toBeUndefined()
    expect(parseCard(text, 'mogilev-minsk', '2026-10-15', 0, seenAt, { ...calendar, label: '16 окт., пт' })).toBeUndefined()
    expect(parseCard(text, 'mogilev-minsk', '2026-10-16', 0, seenAt, { label: '16 окт., пт', selected: true })).toBeUndefined()
    expect(parseCard(text.replace(duration, 'В пути 2 ч'), 'mogilev-minsk', '2026-10-15', 0, seenAt, calendar)).toBeUndefined()
  })
  it('uses the explicit next-day arrival to prove a date omitted from a current-day departure', () => {
    const text = ['22:30', 'Минск', 'Тестовая остановка отправления', '01:30', '15 окт., чт', 'Могилёв', 'Тестовая остановка прибытия', '35', 'свободно 2 места', 'Mercedes Sprinter', 'В пути: 3 ч'].join('\n')
    const trip = parseCard(text, 'minsk-mogilev', '2026-10-14', 0, '2026-10-14T19:00:00Z')
    expect(trip).toMatchObject({ serviceDate: '2026-10-14', durationMinutes: 180, originStop: 'Тестовая остановка отправления', destinationStop: 'Тестовая остановка прибытия' })
    expect(trip?.arrivalAt).toBe('2026-10-15T01:30:00+03:00')
    expect(parseCard(text, 'minsk-mogilev', '2026-10-15', 0, '2026-10-14T19:00:00Z')).toBeUndefined()
  })
  it('keeps inconsistent current-day timing unconfirmed even when the calendar matches', () => {
    const text = ['05:55', 'Могилёв', 'Автовокзал', '08:56', 'Минск', 'Центральный', '25', 'В пути 3 ч 5 мин'].join('\n')
    expect(parseCard(text, 'mogilev-minsk', '2026-11-14', 0, '2026-11-13T21:30:00Z',
      { label: '14 нояб., сб', selected: true })).toBeUndefined()
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
