import { addDays, addMinutes, localDate, minskIso } from '../lib/date'
import type { Direction, SourceHealth, Trip, TripsResponse, VehicleType } from '../types'

const schedules = [
  { time: '05:35', duration: 150, carrier: 'ИП Кононов В. В.', vehicle: 'Volkswagen Crafter', price: 30, seats: 4, source: 'АвтоСлава', sourceId: 'avtoslava', kind: 'carrier' as const, fromStop: 'Автовокзал', toStop: 'АС Автозаводская' },
  { time: '06:50', duration: 180, carrier: 'ООО ВитЭкспресс', vehicle: 'Mercedes-Benz Sprinter', price: 30, seats: 2, source: 'АвтоСлава', sourceId: 'avtoslava', kind: 'carrier' as const, fromStop: 'Автовокзал', toStop: 'Центральный автовокзал' },
  { time: '06:59', duration: 163, carrier: 'Белорусская железная дорога', vehicle: 'Межрегиональный поезд бизнес-класса', price: 25.28, seats: 10, source: 'БЖД', sourceId: 'bzd', kind: 'carrier' as const, fromStop: 'Могилёв-1', toStop: 'Минск-Пассажирский' },
  { time: '07:30', duration: 175, carrier: 'ИП Афонасенко С. Г.', vehicle: 'Volkswagen Crafter', price: 25, seats: 1, source: 'Atlas', sourceId: 'atlas', kind: 'platform' as const, fromStop: 'ост. Симонова', toStop: 'Центральный автовокзал' },
  { time: '08:20', duration: 150, carrier: 'ЧП СтритТорг', vehicle: 'Mercedes-Benz Sprinter', price: 30, seats: 5, source: 'АвтоСлава', sourceId: 'avtoslava', kind: 'carrier' as const, fromStop: 'Автовокзал', toStop: 'АС Автозаводская' },
  { time: '09:45', duration: 170, carrier: 'Минск Экспресс', vehicle: 'Mercedes-Benz Sprinter', price: 20, seats: 3, source: 'Минск Экспресс', sourceId: 'minsk-express', kind: 'carrier' as const, fromStop: 'ост. Дворец гимнастики', toStop: 'Кирова, 8' },
  { time: '11:45', duration: 180, carrier: 'ООО ВитЭкспресс', vehicle: 'Mercedes-Benz Sprinter', price: 30, seats: 0, source: 'АвтоСлава', sourceId: 'avtoslava', kind: 'carrier' as const, fromStop: 'Автовокзал', toStop: 'Центральный автовокзал' },
  { time: '12:20', duration: 150, carrier: 'Минск Экспресс', vehicle: 'Mercedes-Benz Sprinter', price: 20, seats: 2, source: 'Минск Экспресс', sourceId: 'minsk-express', kind: 'carrier' as const, fromStop: 'ост. Симонова', toStop: 'Кирова, 8' },
  { time: '13:30', duration: 180, carrier: 'ОАО Могилевоблавтотранс', vehicle: 'МАЗ 251062', price: 30, seats: 8, source: 'TicketBus', sourceId: 'ticketbus', kind: 'platform' as const, fromStop: 'Автовокзал, платформа №2', toStop: 'Центральный автовокзал' },
  { time: '15:45', duration: 180, carrier: 'ООО ПРОГРЕССЛАЙН', vehicle: 'Mercedes-Benz Sprinter', price: 25, seats: 5, source: 'Atlas', sourceId: 'atlas', kind: 'platform' as const, fromStop: 'Автовокзал', toStop: 'Центральный автовокзал' },
  { time: '17:50', duration: 165, carrier: 'Минск Экспресс', vehicle: 'Mercedes-Benz Sprinter', price: 20, seats: 1, source: 'Минск Экспресс', sourceId: 'minsk-express', kind: 'carrier' as const, fromStop: 'ост. Дворец гимнастики', toStop: 'Кирова, 8' },
  { time: '19:10', duration: 150, carrier: 'ЧТУП АвтоСлаваГолд', vehicle: 'Volkswagen Crafter', price: 25, seats: 3, source: 'АвтоСлава', sourceId: 'avtoslava', kind: 'carrier' as const, fromStop: 'Автовокзал', toStop: 'АС Автозаводская' },
  { time: '21:00', duration: 180, carrier: 'ООО КравченкоТур', vehicle: 'Yutong ZK6128H', price: 30, seats: 9, source: 'Atlas', sourceId: 'atlas', kind: 'platform' as const, fromStop: 'Автовокзал', toStop: 'Центральный автовокзал' },
]

const sourceHealth: SourceHealth[] = [
  { id: 'atlas', name: 'Atlas', kind: 'platform', url: 'https://atlasbus.by/', status: 'ok', tripsFound: 18 },
  { id: 'avtoslava', name: 'АвтоСлава', kind: 'carrier', url: 'https://avto-slava.by/', status: 'ok', tripsFound: 22 },
  { id: 'minsk-express', name: 'Минск Экспресс', kind: 'carrier', url: 'https://mogilevminsk.by/', status: 'ok', tripsFound: 10 },
  { id: 'grandexpress', name: 'ГрандЭкспресс', kind: 'carrier', url: 'https://grandexpress.by/', status: 'unchecked', message: 'Нет опубликованных рейсов на выбранную дату' },
  { id: 'ticketbus', name: 'TicketBus', kind: 'platform', url: 'https://ticketbus.by/', status: 'stale', message: 'Источник отвечает медленно' },
  { id: 'bzd', name: 'БЖД', kind: 'carrier', url: 'https://pass.rw.by/ru/', status: 'ok', tripsFound: 3 },
]

function typeFor(vehicle: string): VehicleType {
  if (/поезд/i.test(vehicle)) return 'train'
  return /маз|yutong/i.test(vehicle) ? 'bus' : 'minibus'
}

export function buildDemoTrips(direction: Direction, days = 30): Trip[] {
  const today = localDate()
  const seenAt = new Date().toISOString()
  return Array.from({ length: days }, (_, day) => {
    const date = addDays(today, day)
    return schedules.map((item, index) => {
      const departureAt = minskIso(date, item.time)
      const reverse = direction === 'minsk-mogilev'
      const availability = item.seats > 0 ? 'available' as const : 'sold_out' as const
      const url = item.sourceId === 'minsk-express'
        ? 'https://mogilevminsk.by/'
        : item.sourceId === 'avtoslava'
          ? 'https://avto-slava.by/'
          : item.sourceId === 'bzd'
            ? 'https://pass.rw.by/ru/'
            : item.sourceId === 'ticketbus'
              ? 'https://ticketbus.by/'
              : reverse
                ? 'https://atlasbus.by/Маршруты/Минск/Могилёв'
                : 'https://atlasbus.by/Маршруты/Могилёв/Минск'
      return {
        id: `demo-${direction}-${date}-${index}`,
        direction,
        serviceDate: date,
        departureAt,
        arrivalAt: addMinutes(departureAt, item.duration),
        durationMinutes: item.duration,
        carrierId: item.carrier.toLowerCase().replace(/\s/g, '-'),
        carrierName: item.carrier,
        vehicleType: typeFor(item.vehicle),
        vehicleName: item.vehicle,
        originStop: reverse ? item.toStop : item.fromStop,
        destinationStop: reverse ? item.fromStop : item.toStop,
        price: item.price,
        currency: 'BYN' as const,
        availability,
        seats: item.seats,
        bookingOptions: [{
          sourceId: item.sourceId,
          sourceName: item.source,
          sourceKind: item.kind,
          url,
          price: item.price,
          currency: 'BYN' as const,
          availability,
          seats: item.seats,
        }],
        lastSeenAt: seenAt,
      }
    })
  }).flat()
}

export function demoResponse(direction: Direction, date: string): TripsResponse {
  const generatedAt = new Date().toISOString()
  return {
    direction,
    date,
    generatedAt,
    stale: false,
    trips: buildDemoTrips(direction).filter((trip) => trip.serviceDate === date),
    sources: sourceHealth.map((source) => ({ ...source, checkedAt: generatedAt, lastSuccessAt: source.status === 'ok' ? generatedAt : undefined })),
  }
}
