import { chromium } from '@playwright/test'
import { addDays, addMinutes, localDate, minskIso } from '../../src/lib/date'
import { slugify, vehicleTypeFromName } from '../../src/lib/trips'
import type { AvailabilityStatus, Direction, Trip } from '../../src/types'
import { errorResult, type SourceResult } from '../lib/source'

const urls: Record<Direction, string> = {
  'mogilev-minsk': 'https://atlasbus.by/Маршруты/Могилёв/Минск',
  'minsk-mogilev': 'https://atlasbus.by/Маршруты/Минск/Могилёв',
}

function parseCard(text: string, direction: Direction, date: string, index: number, seenAt: string): Trip | undefined {
  const lines = text.split('\n').map((line) => line.trim()).filter(Boolean)
  const times = lines.filter((line) => /^\d{2}:\d{2}$/.test(line)).slice(0, 2)
  if (times.length < 2) return undefined
  const firstTime = lines.indexOf(times[0])
  const secondTime = lines.indexOf(times[1], firstTime + 1)
  const originStop = lines[firstTime + 2] || (direction === 'mogilev-minsk' ? 'Могилёв' : 'Минск')
  const destinationStop = lines[secondTime + 2] || (direction === 'mogilev-minsk' ? 'Минск' : 'Могилёв')
  const durationMatch = text.match(/В пути:\s*(\d+)\s*ч(?:\s*(\d+)\s*мин)?/i)
  const durationMinutes = durationMatch ? Number(durationMatch[1]) * 60 + Number(durationMatch[2] || 0) : 180
  const priceLine = lines.find((line) => /^\d+(?:[.,]\d+)?\s*[^A-Za-zА-Яа-я0-9]*$/u.test(line))
  const price = Number.parseFloat(priceLine?.replace(',', '.') || '0')
  if (!price) return undefined
  const soldOut = /нет мест/i.test(text)
  const availability: AvailabilityStatus = soldOut ? 'sold_out' : 'available'
  const vehicleName = lines.find((line) => /sprinter|crafter|maz|маз|yutong|голаз|mercedes|volkswagen/i.test(line))
  const departureAt = minskIso(date, times[0])
  const carrierName = 'Перевозчик Atlas'
  return {
    id: `atlas:${direction}:${date}:${times[0]}:${slugify(originStop)}:${index}`,
    direction,
    serviceDate: date,
    departureAt,
    arrivalAt: addMinutes(departureAt, durationMinutes),
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
    bookingOptions: [{ sourceId: 'atlas', sourceName: 'Atlas', sourceKind: 'platform', url: urls[direction], price, currency: 'BYN', availability }],
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
      const dateButtons = page.locator('[data-testid="price-calendar-item-button"]')
      const dateCount = Math.min(await dateButtons.count(), horizonDays)
      for (let day = 0; day < dateCount; day += 1) {
        if (day > 0) {
          const button = dateButtons.nth(day)
          if (await button.isEnabled()) {
            await button.click()
            await page.waitForTimeout(450)
          }
        }
        const detailButtons = page.locator('button').filter({ hasText: 'Показать детали' })
        if (await detailButtons.count() > 0) await detailButtons.first().waitFor({ state: 'visible', timeout: 15_000 })
        const cardTexts = await detailButtons.evaluateAll((buttons) => buttons.map((button) => {
          let element: HTMLElement | null = button as HTMLElement
          for (let level = 0; level < 8 && element; level += 1, element = element.parentElement) {
            const text = element.innerText || ''
            if (text.includes('В пути:') && /\d{2}:\d{2}/.test(text)) return text.slice(0, 1400)
          }
          return ''
        }).filter(Boolean))
        cardTexts.forEach((text, index) => {
          const trip = parseCard(text, direction, addDays(localDate(), day), index, seenAt)
          if (trip) trips.push(trip)
        })
      }
    }
    await browser.close()
    return { trips, health: { id: 'atlas', name: 'Atlas', kind: 'platform', url: 'https://atlasbus.by/', status: 'ok', checkedAt: seenAt, lastSuccessAt: seenAt, tripsFound: trips.length } }
  } catch (error) {
    await browser?.close().catch(() => undefined)
    return errorResult('atlas', 'Atlas', 'platform', 'https://atlasbus.by/', error)
  }
}
