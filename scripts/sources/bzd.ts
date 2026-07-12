import { addDays, addMinutes, localDate, minskIso } from '../../src/lib/date'
import type { AvailabilityStatus, Direction, Trip } from '../../src/types'
import { fetchWithTimeout } from '../lib/fetch'
import { errorResult, type SourceResult } from '../lib/source'

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

function parseDuration(value: string): number {
  const hours = Number(value.match(/(\d+)\s*ч/u)?.[1] || 0)
  const minutes = Number(value.match(/(\d+)\s*мин/u)?.[1] || 0)
  return hours * 60 + minutes || 180
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

    const sellingAllowed = capture(block, /data-ticket_selling_allowed="([^"]+)"/i) === 'true'
    const price = Math.max(0, Number(capture(block, /sch-table__tickets"[^>]*data-value="([^"]+)"/i).replace(',', '.')) || 0)
    const availability: AvailabilityStatus = sellingAllowed ? 'available' : 'sold_out'
    const durationMinutes = parseDuration(durationText)
    const departureAt = minskIso(serviceDate, departure)
    const bookingUrl = href ? new URL(href, sourceUrl).toString() : bzdRouteUrl(direction, serviceDate)

    return [{
      id: `bzd:${serviceDate}:${trainId}`,
      direction,
      serviceDate,
      departureAt,
      arrivalAt: addMinutes(departureAt, durationMinutes),
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
      }],
      lastSeenAt: seenAt,
    }]
  })
}

async function mapConcurrent<T, R>(items: T[], limit: number, task: (item: T) => Promise<R>): Promise<R[]> {
  const results = new Array<R>(items.length)
  let cursor = 0
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (cursor < items.length) {
      const index = cursor
      cursor += 1
      results[index] = await task(items[index])
    }
  }))
  return results
}

export async function collectBzd(horizonDays = 30): Promise<SourceResult> {
  const checkedAt = new Date().toISOString()
  try {
    const today = localDate()
    const requests = Array.from({ length: horizonDays }, (_, day) => (['mogilev-minsk', 'minsk-mogilev'] as const).map((direction) => ({ direction, date: addDays(today, day) }))).flat()
    const batches = await mapConcurrent(requests, 5, async ({ direction, date }) => {
      const response = await fetchWithTimeout(bzdRouteUrl(direction, date), {}, 35_000)
      return parseBzdHtml(await response.text(), direction, date, checkedAt)
    })
    const trips = batches.flat()
    return {
      trips,
      health: {
        id: 'bzd',
        name: 'БЖД',
        kind: 'carrier',
        url: sourceUrl,
        status: 'ok',
        checkedAt,
        lastSuccessAt: checkedAt,
        tripsFound: trips.length,
      },
    }
  } catch (error) {
    return errorResult('bzd', 'БЖД', 'carrier', sourceUrl, error)
  }
}
