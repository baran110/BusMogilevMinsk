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
  // Codes are verified against the official form and train links; do not rely
  // on resolving an ambiguous city name for every date request.
  const mogilev = { name: 'Могилёв-1', code: '2100150' }
  const minsk = { name: 'Минск-Пассажирский', code: '2100000' }
  const [from, to] = direction === 'mogilev-minsk' ? [mogilev, minsk] : [minsk, mogilev]
  const query = new URLSearchParams({ from: from.name, from_exp: from.code, to: to.name, to_exp: to.code, date })
  return `https://pass.rw.by/ru/route/?${query}`
}

function trainRows(html: string): string[] {
  const rows: string[] = []
  for (const match of html.matchAll(/<div\b[^>]*\bclass=["']([^"']*)["'][^>]*>/gi)) {
    const classes = match[1].split(/\s+/)
    if (!classes.includes('sch-table__row-wrap') || !classes.includes('js-row')) continue
    // Class order and disabled departed rows vary. End at this wrapper's closing
    // div so hidden footer messages cannot change a train's availability.
    const tags = /<\/?div\b[^>]*>/gi
    tags.lastIndex = match.index + match[0].length
    let depth = 1
    let tag: RegExpExecArray | null
    while ((tag = tags.exec(html))) {
      depth += /^<\//.test(tag[0]) ? -1 : 1
      if (depth === 0) { rows.push(html.slice(match.index, tags.lastIndex)); break }
    }
    if (depth !== 0) throw new Error('БЖД: строка расписания повреждена')
  }
  return rows
}

export function parseBzdHtml(html: string, direction: Direction, serviceDate: string, seenAt: string): Trip[] {
  return trainRows(html).map((block): Trip => {
    const trainNumber = capture(block, /data-train-number="([^"]+)"/i)
    const trainId = capture(block, /data-train-id="([^"]+)"/i) || trainNumber
    const trainType = capture(block, /data-train-type="([^"]+)"/i)
    const departure = capture(block, /train-from-time"[^>]*>([^<]+)/i)
    const arrival = capture(block, /train-to-time"[^>]*>\s*([^<]+)/i)
    const originStop = capture(block, /train-from-name"[^>]*>([^<]+)/i)
    const destinationStop = capture(block, /train-to-name"[^>]*>([^<]+)/i)
    const durationText = capture(block, /train-duration-time"[^>]*>\s*([^<]+)/i)
    const href = capture(block, /<a\s+href="([^"]+)"\s+class="sch-table__route"/i)
    if (!trainNumber || !departure || !arrival || !originStop || !destinationStop) throw new Error('БЖД: строка поезда не распознана полностью')

    const ticketPrice = knownNumber(capture(block, /sch-table__tickets"[^>]*data-value="([^"]+)"/i))
    // The official page uses zero as the sorting value of an empty ticket cell.
    const price = ticketPrice !== null && ticketPrice > 0 ? ticketPrice : null
    // Ticket selling being enabled says nothing about remaining seats.
    const availability: AvailabilityStatus = /нет мест/iu.test(decodeText(block)) ? 'sold_out' : 'unknown'
    const departureAt = validatedDeparture(serviceDate, departure)
    const arrivalAt = arrivalFromClock(serviceDate, departureAt, arrival)
    const durationMinutes = parseDuration(durationText) ?? (arrivalAt ? (Date.parse(arrivalAt) - Date.parse(departureAt)) / 60000 : null)
    const bookingUrl = href ? new URL(href, sourceUrl).toString() : bzdRouteUrl(direction, serviceDate)
    const linkedDate = new URL(bookingUrl).searchParams.get('date')
    if (!linkedDate || linkedDate !== serviceDate) throw new Error('БЖД: дата рейса в ссылке не совпадает с запросом')

    return {
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
    }
  })
}

export async function collectBzd(horizonDays = 30): Promise<SourceResult> {
  return collectPairs({ id: 'bzd', name: 'БЖД', kind: 'carrier', url: sourceUrl }, requestedPairs(horizonDays), async (direction, date) => {
    const started = Date.now()
    // A measured successful official response took 17.8 s including TLS/body.
    // The shared 12 s default would discard it. The source deadline still bounds the whole cycle.
    const response = await fetchWithTimeout(bzdRouteUrl(direction, date), {}, 25_000)
    const html = await response.text()
    if (process.env.DEBUG_SOURCE_SCHEMA === '1') console.log(JSON.stringify({ bzdRequest: {
      direction, date, status: response.status, elapsedMs: Date.now() - started, bytes: Buffer.byteLength(html, 'utf8'),
    } }))
    const trips = parseBzdHtml(html, direction, date, new Date().toISOString())
    // Generic empty-message strings can also be hidden templates in a page that
    // contains trains. Without recognised rows the result remains unconfirmed.
    if (!trips.length) {
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
