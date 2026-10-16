import { chromium } from '@playwright/test'
import { addDays, localDate } from '../../src/lib/date'
import { slugify, vehicleTypeFromName } from '../../src/lib/trips'
import type { AvailabilityStatus, Direction, Trip } from '../../src/types'
import { errorResult, type SourceResult } from '../lib/source'
import { arrivalFromClock, knownNumber, validatedDeparture } from '../lib/normalize'
import { sourceSignal, throwIfSourceExpired } from '../lib/runtime'
import type { SourceCoverage } from '../../src/types'
import { requestedPairs } from '../lib/coverage'

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

interface CalendarSelection { label: string; selected: boolean }

export function parseCard(text: string, direction: Direction, date: string, index: number, seenAt: string, calendar?: CalendarSelection): Trip | undefined {
  const lines = text.split('\n').map((line) => line.trim()).filter(Boolean)
  const times = lines.filter((line) => /^\d{2}:\d{2}$/.test(line)).slice(0, 2)
  if (times.length < 2) return undefined
  const firstTime = lines.indexOf(times[0])
  const secondTime = lines.indexOf(times[1], firstTime + 1)
  const departureDateLabel = dateFromCalendarLabel(lines[firstTime + 1] || '', date)
  const arrivalDateLabel = dateFromCalendarLabel(lines[secondTime + 1] || '', date)
  const durationMatch = text.match(/В пути:\s*(\d+)\s*ч(?:\s*(\d+)\s*мин)?/i)
  const statedDuration = durationMatch ? Number(durationMatch[1]) * 60 + Number(durationMatch[2] || 0) : null
  const today = localDate(new Date(seenAt))
  const confirmedToday = !departureDateLabel && !arrivalDateLabel && date === today && calendar?.selected
    && dateFromCalendarLabel(calendar.label, today) === date && statedDuration !== null && statedDuration > 0 && statedDuration < 1440
  // The current-day departure can omit its date. An explicit arrival date plus
  // a stated journey shorter than a day still proves the departure day, including midnight crossings.
  const provenDate = departureDateLabel ?? (arrivalDateLabel && statedDuration !== null && statedDuration > 0 && statedDuration < 1440
    ? addDays(arrivalDateLabel, times[0] > times[1] ? -1 : 0) : confirmedToday ? date : undefined)
  if (provenDate !== date) return undefined
  const fromIndex = firstTime + (departureDateLabel ? 2 : 1)
  const toIndex = secondTime + (arrivalDateLabel ? 2 : 1)
  const fromCity = direction === 'mogilev-minsk' ? /могил[её]в/iu : /минск/iu
  const toCity = direction === 'mogilev-minsk' ? /минск/iu : /могил[её]в/iu
  if (!fromCity.test(lines[fromIndex] || '') || !toCity.test(lines[toIndex] || '')) return undefined
  const originStop = lines[fromIndex + 1]
  const destinationStop = lines[toIndex + 1]
  if (!originStop || !destinationStop) return undefined
  const departureAt = validatedDeparture(date, times[0])
  const arrivalAt = arrivalDateLabel ? validatedDeparture(arrivalDateLabel, times[1]) : arrivalFromClock(date, departureAt, times[1])
  const durationMinutes = arrivalAt ? (Date.parse(arrivalAt) - Date.parse(departureAt)) / 60000 : statedDuration
  if (durationMinutes !== null && (durationMinutes <= 0 || durationMinutes >= 1440)) return undefined
  if (confirmedToday && durationMinutes !== statedDuration) return undefined
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
  const trips: Trip[] = []
  const coverage: SourceCoverage[] = []
  let browser: Awaited<ReturnType<typeof chromium.launch>> | undefined
  try {
    browser = await chromium.launch({ headless: true })
    const abort = () => { void browser?.close().catch(() => undefined) }
    sourceSignal()?.addEventListener('abort', abort, { once: true })
    const page = await browser.newPage({ locale: 'ru-RU', timezoneId: 'Europe/Minsk' })
    for (const direction of ['mogilev-minsk', 'minsk-mogilev'] as const) {
      throwIfSourceExpired()
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
        throwIfSourceExpired()
        const button = dateButtons.nth(day)
        const label = await button.innerText()
        const serviceDate = dateFromCalendarLabel(label)
        if (process.env.DEBUG_ATLAS === '1') console.log(`[atlas] ${direction}: ${JSON.stringify(label)} -> ${serviceDate || 'unknown'}`)
        if (!serviceDate || serviceDate >= addDays(localDate(), horizonDays)) continue
        try {
        if (label.includes('Нет рейсов')) {
          coverage.push({ direction, date: serviceDate, checkedAt: new Date().toISOString(), status: 'ok' })
          continue
        }
        if (!await button.isEnabled()) continue
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
        let parsed: Trip[] = []
        let cardTexts: string[] = []
        for (let attempt = 0; attempt < 30; attempt++) {
        throwIfSourceExpired()
        cardTexts = await detailButtons.evaluateAll((buttons) => buttons.map((button) => {
          let element: HTMLElement | null = button as HTMLElement
          for (let level = 0; level < 16 && element; level += 1, element = element.parentElement) {
            const text = element.innerText || ''
            if (text.includes('В пути:') && /\d{2}:\d{2}/.test(text)) return text.slice(0, 1400)
          }
          return ''
        }).filter(Boolean))
        if (process.env.DEBUG_ATLAS === '1') console.log(`[atlas] ${direction} ${serviceDate}: ${cardTexts.length} card texts`)
        const observedAt = new Date().toISOString()
        const calendar = await button.evaluate((element) => ({ label: (element as HTMLElement).innerText, selected: element.getAttribute('aria-selected') === 'true' }))
        parsed = []
        cardTexts.forEach((text, index) => {
          const trip = parseCard(text, direction, serviceDate, index, observedAt, calendar)
          if (trip) parsed.push(trip)
        })
        if (parsed.length > 0 && parsed.length === cardTexts.length) break
        await page.waitForTimeout(250)
        }
        if (process.env.DEBUG_SOURCE_SCHEMA === '1' && !parsed.length) {
          console.log(JSON.stringify({ atlasSchema: { direction, requestedDate: serviceDate,
            cards: cardTexts.length, datePositions: cardTexts.slice(0, 2).map((text) => text.split('\n').map((line, index) => dateFromCalendarLabel(line, serviceDate) ? index : -1).filter((index) => index >= 0)),
            timePositions: cardTexts.slice(0, 2).map((text) => text.split('\n').map((line, index) => /^\d{2}:\d{2}$/.test(line.trim()) ? index : -1).filter((index) => index >= 0)),
            calendarButtons: await dateButtons.evaluateAll((buttons) => buttons.slice(0, 3).map((element) => element.outerHTML.slice(0, 2000))),
            dateInputs: await page.locator('input').evaluateAll((inputs) => inputs.filter((element): element is HTMLInputElement => element instanceof HTMLInputElement && /^\d{4}-\d{2}-\d{2}$/.test(element.value))
              .slice(0, 10).map((element) => ({ name: element.name, value: element.value, testId: element.getAttribute('data-testid') }))) } }))
        }
        if (!parsed.length) throw new Error(`Atlas: дата карточек ${serviceDate} не подтверждена`)
        parsed.forEach((trip) => {
          if (trip) trips.push(trip)
        })
        coverage.push({ direction, date: serviceDate, checkedAt: new Date().toISOString(), status: parsed.length === cardTexts.length ? 'ok' : 'error' })
        } catch (error) {
          throwIfSourceExpired()
          coverage.push({ direction, date: serviceDate, status: 'error', checkedAt: new Date().toISOString(), message: error instanceof Error ? error.message.slice(0, 180) : 'Дата не подтверждена' })
        }
      }
      if (datesWithTrips > 0 && !trips.some((trip) => trip.direction === direction)) {
        throw new Error(`Atlas опубликовал ${datesWithTrips} дат с рейсами, но карточки не распознаны`)
      }
    }
    await browser.close()
    sourceSignal()?.removeEventListener('abort', abort)
    for (const pair of requestedPairs(horizonDays)) {
      if (!coverage.some((item) => item.direction === pair.direction && item.date === pair.date)) coverage.push({ ...pair, status: 'error', checkedAt: new Date().toISOString(), message: 'Дата не подтверждена календарём Atlas' })
    }
    return { trips, health: { id: 'atlas', name: 'Atlas', kind: 'platform', url: 'https://atlasbus.by/', status: coverage.some((item) => item.status === 'error') ? 'stale' : 'ok', checkedAt: new Date().toISOString(), lastSuccessAt: coverage.filter((item) => item.status === 'ok').map((item) => item.checkedAt).sort().at(-1), tripsFound: trips.length, coverage,
      message: coverage.find((item) => item.status === 'error')?.message } }
  } catch (error) {
    await browser?.close().catch(() => undefined)
    const failed = errorResult('atlas', 'Atlas', 'platform', 'https://atlasbus.by/', error)
    for (const pair of requestedPairs(horizonDays)) {
      if (!coverage.some((item) => item.direction === pair.direction && item.date === pair.date)) coverage.push({ ...pair, status: 'error',
        checkedAt: new Date().toISOString(), message: failed.health.message })
    }
    return { trips, health: { ...failed.health, status: coverage.some((item) => item.status === 'ok') ? 'stale' : 'error', coverage,
      tripsFound: trips.length, lastSuccessAt: coverage.filter((item) => item.status === 'ok').map((item) => item.checkedAt).sort().at(-1) } }
  }
}
