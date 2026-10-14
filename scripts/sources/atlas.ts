import { chromium } from '@playwright/test'
import { addMinutes, localDate, minskIso } from '../../src/lib/date'
import { slugify, vehicleTypeFromName } from '../../src/lib/trips'
import type { AvailabilityStatus, Direction, Trip } from '../../src/types'
import { errorResult, type SourceResult } from '../lib/source'
import { arrivalFromClock, knownNumber, validatedDeparture } from '../lib/normalize'

const urls: Record<Direction, string> = {
  'mogilev-minsk': 'https://atlasbus.by/Маршруты/Могилёв/Минск',
  'minsk-mogilev': 'https://atlasbus.by/Маршруты/Минск/Могилёв',
}

const monthNumbers: Record<string, number> = {
  янв: 1,
  фев: 2,
  мар: 3,
  апр: 4,
  мая: 5,
  июн: 6,
  июл: 7,
  авг: 8,
  сен: 9,
  окт: 10,
  ноя: 11,
  дек: 12,
}

export function dateFromCalendarLabel(label: string, referenceDate = localDate()): string | undefined {
  const match = label.toLowerCase().match(/(\d{1,2})\s+(янв|фев|мар|апр|мая|июн|июл|авг|сен|окт|ноя|дек)/)
  if (!match) return undefined
  const [, yearText, monthText, dayText] = referenceDate.match(/^(\d{4})-(\d{2})-(\d{2})$/) || []
  if (!yearText) return undefined
  const month = monthNumbers[match[2]]
  const day = Number(match[1])
  const referenceMonth = Number(monthText)
  const referenceDay = Number(dayText)
  const year = Number(yearText) + (month < referenceMonth || (month === referenceMonth && day < referenceDay) ? 1 : 0)
  return `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`
}

export function parseCard(text: string, direction: Direction, date: string, index: number, seenAt: string): Trip | undefined {
  const lines = text.split('\n').map((line) => line.trim()).filter(Boolean)
  const times = lines.filter((line) => /^\d{2}:\d{2}$/.test(line)).slice(0, 2)
  if (times.length < 2) return undefined
  const firstTime = lines.indexOf(times[0])
  const secondTime = lines.indexOf(times[1], firstTime + 1)
  const originStop = lines[firstTime + 3] || (direction === 'mogilev-minsk' ? 'Могилёв' : 'Минск')
  const destinationStop = lines[secondTime + 2] || (direction === 'mogilev-minsk' ? 'Минск' : 'Могилёв')
  const durationMatch = text.match(/В пути:\s*(\d+)\s*ч(?:\s*(\d+)\s*мин)?/i)
  const departureAt = validatedDeparture(date, times[0])
  const arrivalAt = arrivalFromClock(date, departureAt, times[1])
  const durationMinutes = durationMatch ? Number(durationMatch[1]) * 60 + Number(durationMatch[2] || 0) : arrivalAt ? (Date.parse(arrivalAt) - Date.parse(departureAt)) / 60000 : null
  const priceLine = lines.find((line) => /^\d+(?:[.,]\d+)?\s*[^A-Za-zА-Яа-я0-9]*$/u.test(line))
  const price = knownNumber(priceLine?.match(/^\d+(?:[.,]\d+)?/)?.[0])
  const soldOut = /нет мест/i.test(text)
  const seatsMatch = text.match(/свободно\s+(\d+)\+?\s+мест/i)
  const seats = soldOut ? 0 : /последнее место/i.test(text) ? 1 : seatsMatch ? Number(seatsMatch[1]) : undefined
  const availability: AvailabilityStatus = seats === 0 ? 'sold_out' : seats === undefined ? 'unknown' : 'available'
  const vehicleName = lines.find((line) => /sprinter|crafter|maz|маз|yutong|голаз|mercedes|volkswagen/i.test(line))
  const carrierName = 'Перевозчик не указан (Atlas)'
  return {
    id: `atlas:${direction}:${date}:${times[0]}:${slugify(originStop)}:${index}`,
    direction,
    serviceDate: date,
    departureAt,
    arrivalAt,
    durationMinutes,
    carrierId: 'atlas-partner',
    carrierName,
    vehicleType: vehicleTypeFromName(vehicleName),
    vehicleName,
    originStop,
    destinationStop,
    price,
    currency: 'BYN',
    availability,
    seats,
    bookingOptions: [{ sourceId: 'atlas', sourceName: 'Atlas', sourceKind: 'platform', url: `${urls[direction]}?date=${date}&passengers=1`, price, currency: 'BYN', availability, seats,
      observedAt: seenAt, priceObservedAt: price === null ? undefined : seenAt, availabilityObservedAt: availability === 'unknown' ? undefined : seenAt }],
    lastSeenAt: seenAt,
  }
}

export async function collectAtlas(horizonDays = 30): Promise<SourceResult> {
  const seenAt = new Date().toISOString()
  let browser
  try {
    browser = await chromium.launch({ headless: true })
    const page = await browser.newPage({ locale: 'ru-RU', timezoneId: 'Europe/Minsk' })
    const trips: Trip[] = []
    for (const direction of ['mogilev-minsk', 'minsk-mogilev'] as const) {
      await page.goto(urls[direction], { waitUntil: 'domcontentloaded', timeout: 45_000 })
      await page.waitForSelector('button', { timeout: 20_000 })
      const rejectCookies = page.getByRole('button', { name: 'Отклонить все' })
      if (await rejectCookies.count() === 1 && await rejectCookies.isVisible()) await rejectCookies.click()
      const searchButton = page.locator('[data-testid="search-button"]')
      await searchButton.waitFor({ state: 'visible', timeout: 20_000 })
      await searchButton.click()
      await page.waitForSelector('[data-testid="price-calendar-item-button"]', { timeout: 20_000 })
      const detailButtons = page.locator('button').filter({ hasText: 'Показать детали' })
      await detailButtons.first().waitFor({ state: 'visible', timeout: 20_000 })
      if (await rejectCookies.count() === 1 && await rejectCookies.isVisible()) await rejectCookies.click()
      const dateButtons = page.locator('[data-testid="price-calendar-item-button"]')
      const dateCount = Math.min(await dateButtons.count(), horizonDays)
      let datesWithTrips = 0
      if (process.env.DEBUG_ATLAS === '1') console.log(`[atlas] ${direction}: ${dateCount} calendar dates, ${page.url()}`)
      for (let day = 0; day < dateCount; day += 1) {
        const button = dateButtons.nth(day)
        const label = await button.innerText()
        const serviceDate = dateFromCalendarLabel(label)
        if (process.env.DEBUG_ATLAS === '1') console.log(`[atlas] ${direction}: ${JSON.stringify(label)} -> ${serviceDate || 'unknown'}`)
        if (!serviceDate || label.includes('Нет рейсов') || !await button.isEnabled()) continue
        datesWithTrips += 1
        if (!page.url().includes(`date=${serviceDate}`)) {
          await button.click()
          for (let attempt = 0; attempt < 40 && !page.url().includes(`date=${serviceDate}`); attempt += 1) {
            await page.waitForTimeout(250)
          }
          if (!page.url().includes(`date=${serviceDate}`)) throw new Error(`Atlas не переключил календарь на ${serviceDate}`)
          await page.waitForTimeout(750)
        }
        await detailButtons.first().waitFor({ state: 'visible', timeout: 15_000 })
        const cardTexts = await detailButtons.evaluateAll((buttons) => buttons.map((button) => {
          let element: HTMLElement | null = button as HTMLElement
          for (let level = 0; level < 16 && element; level += 1, element = element.parentElement) {
            const text = element.innerText || ''
            if (text.includes('В пути:') && /\d{2}:\d{2}/.test(text)) return text.slice(0, 1400)
          }
          return ''
        }).filter(Boolean))
        if (process.env.DEBUG_ATLAS === '1') console.log(`[atlas] ${direction} ${serviceDate}: ${cardTexts.length} card texts`)
        cardTexts.forEach((text, index) => {
          const trip = parseCard(text, direction, serviceDate, index, seenAt)
          if (trip) trips.push(trip)
        })
      }
      if (datesWithTrips > 0 && !trips.some((trip) => trip.direction === direction)) {
        throw new Error(`Atlas опубликовал ${datesWithTrips} дат с рейсами, но карточки не распознаны`)
      }
    }
    await browser.close()
    return { trips, health: { id: 'atlas', name: 'Atlas', kind: 'platform', url: 'https://atlasbus.by/', status: 'ok', checkedAt: seenAt, lastSuccessAt: seenAt, tripsFound: trips.length } }
  } catch (error) {
    await browser?.close().catch(() => undefined)
    return errorResult('atlas', 'Atlas', 'platform', 'https://atlasbus.by/', error)
  }
}
