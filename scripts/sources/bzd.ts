import { addDays, addMinutes, localDate, minskIso } from '../../src/lib/date'
import type { AvailabilityStatus, Direction, Trip } from '../../src/types'
import { fetchWithTimeout } from '../lib/fetch'
import type { SourceResult } from '../lib/source'
import { collectPairs, requestedPairs } from '../lib/coverage'
import { arrivalFromClock, knownNumber, validatedDeparture } from '../lib/normalize'

const sourceUrl = 'https://pass.rw.by/ru/'

function decodeText(value = ''): string {
  return value
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;|&#160;/gi, ' ')
    .replace(/&mdash;|&#8212;/gi, '—')
    .replace(/&ndash;|&#8211;/gi, '–')
    .replace(/&quot;|&#34;/gi, '"')
    .replace(/&amp;|&#38;/gi, '&')
    .replace(/\s+/g, ' ')
    .trim()
}

function capture(block: string, pattern: RegExp): string {
  return decodeText(block.match(pattern)?.[1] || '')
}

function parseDuration(value: string): number | null {
  const hours = Number(value.match(/(\d+)\s*ч/u)?.[1] || 0)
  const minutes = Number(value.match(/(\d+)\s*мин/u)?.[1] || 0)
  return hours * 60 + minutes || null
}

function trainName(type: string): string {
  const labels: Record<string, string> = {
    interregional_business: 'Межрегиональный поезд бизнес-класса',
    interregional_economy: 'Межрегиональный поезд экономкласса',
    regional_business: 'Региональный поезд бизнес-класса',
    regional_economy: 'Региональный поезд экономкласса',
    international: 'Международный поезд',
  }
  return labels[type] || 'Поезд БЖД'
}

export function bzdRouteUrl(direction: Direction, date: string): string {
  const from = direction === 'mogilev-minsk' ? 'Могилев' : 'Минск'
  const to = direction === 'mogilev-minsk' ? 'Минск' : 'Могилев'
  const query = new URLSearchParams({ from, to, date })
  return `https://pass.rw.by/ru/route/?${query}`
}

export function parseBzdHtml(html: string, direction: Direction, serviceDate: string, seenAt: string): Trip[] {
  return html.split('<div class="sch-table__row-wrap js-row').slice(1).flatMap((block): Trip[] => {
    const trainNumber = capture(block, /data-train-number="([^"]+)"/i)
    const trainId = capture(block, /data-train-id="([^"]+)"/i) || trainNumber
    const trainType = capture(block, /data-train-type="([^"]+)"/i)
    const departure = capture(block, /train-from-time"[^>]*>([^<]+)/i)
    const arrival = capture(block, /train-to-time"[^>]*>\s*([^<]+)/i)
    const originStop = capture(block, /train-from-name"[^>]*>([^<]+)/i)
    const destinationStop = capture(block, /train-to-name"[^>]*>([^<]+)/i)
    const durationText = capture(block, /train-duration-time"[^>]*>\s*([^<]+)/i)
    const href = capture(block, /<a\s+href="([^"]+)"\s+class="sch-table__route"/i)
    if (!trainNumber || !departure || !arrival || !originStop || !destinationStop) return []

    const price = knownNumber(capture(block, /sch-table__tickets"[^>]*data-value="([^"]+)"/i))
    // Ticket selling being enabled says nothing about remaining seats.
    const availability: AvailabilityStatus = /нет мест/iu.test(decodeText(block)) ? 'sold_out' : 'unknown'
    const departureAt = validatedDeparture(serviceDate, departure)
    const arrivalAt = arrivalFromClock(serviceDate, departureAt, arrival)
    const durationMinutes = parseDuration(durationText) ?? (arrivalAt ? (Date.parse(arrivalAt) - Date.parse(departureAt)) / 60000 : null)
    const bookingUrl = href ? new URL(href, sourceUrl).toString() : bzdRouteUrl(direction, serviceDate)
    const linkedDate = new URL(bookingUrl).searchParams.get('date')
    if (!linkedDate || linkedDate !== serviceDate) throw new Error('БЖД: дата рейса в ссылке не совпадает с запросом')

    return [{
      id: `bzd:${serviceDate}:${trainId}`,
      direction,
      serviceDate,
      departureAt,
      arrivalAt,
      durationMinutes,
      carrierId: 'belorusskaya-zheleznaya-doroga',
      carrierName: 'Белорусская железная дорога',
      vehicleType: 'train',
      vehicleName: trainName(trainType),
      routeNumber: trainNumber,
      originStop,
      destinationStop,
      price,
      currency: 'BYN',
      availability,
      bookingOptions: [{
        sourceId: 'bzd',
        sourceName: 'БЖД',
        sourceKind: 'carrier',
        url: bookingUrl,
        price,
        currency: 'BYN',
        availability,
        observedAt: seenAt,
        priceObservedAt: price === null ? undefined : seenAt,
        availabilityObservedAt: availability === 'unknown' ? undefined : seenAt,
      }],
      lastSeenAt: seenAt,
    }]
  })
}

export async function collectBzd(horizonDays = 30): Promise<SourceResult> {
  return collectPairs({ id: 'bzd', name: 'БЖД', kind: 'carrier', url: sourceUrl }, requestedPairs(horizonDays), async (direction, date) => {
    const response = await fetchWithTimeout(bzdRouteUrl(direction, date))
    const html = await response.text()
    const trips = parseBzdHtml(html, direction, date, new Date().toISOString())
    if (!trips.length && !/поезда не найдены|поездов не найдено|нет поездов/iu.test(decodeText(html))) {
      if (process.env.DEBUG_SOURCE_SCHEMA === '1') console.log(JSON.stringify({ bzdSchema: {
        title: decodeText(html.match(/<title[^>]*>([\s\S]*?)<\/title>/i)?.[1] || '').slice(0, 120),
        challenge: /challenge-platform|__cf_chl|captcha|проверка.*робот/iu.test(html),
        classes: [...new Set([...html.matchAll(/class="([^"]+)"/g)].map((match) => match[1]).filter((value) => /sch-table|train-|no-result|empty|alert|captcha/i.test(value)))].slice(-35),
        emptyMessages: decodeText(html.replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, '').replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, '')).match(/.{0,30}(?:не найден|нет поезд|не курсир|ничего не|не выполня).{0,100}/giu)?.slice(0, 5),
        dateInputs: [...html.matchAll(/<input[^>]+(?:name|id)="([^" ]*date[^" ]*)"/g)].map((match) => match[1]).slice(0, 10),
      } }))
      throw new Error('БЖД: выдача не распознана; это не подтверждение отсутствия поездов')
    }
    const from = direction === 'mogilev-minsk' ? /могил[её]в/iu : /минск/iu
    const to = direction === 'mogilev-minsk' ? /минск/iu : /могил[её]в/iu
    if (trips.some((trip) => !from.test(trip.originStop) || !to.test(trip.destinationStop))) throw new Error('БЖД вернула другое направление')
    return trips
  })
}
