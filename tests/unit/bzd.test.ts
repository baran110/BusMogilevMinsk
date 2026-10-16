import { afterEach, describe, expect, it, vi } from 'vitest'
import { bzdRouteUrl, collectBzd, parseBzdHtml } from '../../scripts/sources/bzd'
import { collectionDeadline, withSourceDeadline } from '../../scripts/lib/runtime'

afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals() })

const row = `
<div class="sch-table__row-wrap js-row from_morning">
  <div class="sch-table__row" data-ticket_selling_allowed="true" data-train-id="1_741Б" data-train-number="741Б" data-train-type="interregional_business">
    <a href="/ru/train/?train=741%D0%91&amp;date=2026-07-13" class="sch-table__route"><span>741Б</span></a>
    <div class="sch-table__time train-from-time" data-value="1">06:59</div>
    <div class="sch-table__station train-from-name">Могилёв-1</div>
    <div class="sch-table__time train-to-time" data-value="2">09:42</div>
    <div class="sch-table__station train-to-name">Минск-Пассажирский</div>
    <div class="sch-table__duration train-duration-time" data-value="163">2 ч 43 мин</div>
    <div class="sch-table__tickets" data-sort="cost" data-value="25.28"></div>
  </div>
</div>`

describe('БЖД adapter', () => {
  it('parses an official train row', () => {
    const trips = parseBzdHtml(row, 'mogilev-minsk', '2026-07-13', '2026-07-12T12:00:00Z')
    expect(trips).toHaveLength(1)
    expect(trips[0]).toMatchObject({
      routeNumber: '741Б',
      vehicleType: 'train',
      durationMinutes: 163,
      price: 25.28,
      availability: 'unknown',
      originStop: 'Могилёв-1',
      destinationStop: 'Минск-Пассажирский',
    })
  })

  it('builds a direction-specific official search URL', () => {
    const url = new URL(bzdRouteUrl('minsk-mogilev', '2026-07-13'))
    expect(url.searchParams.get('from')).toBe('Минск-Пассажирский')
    expect(url.searchParams.get('to')).toBe('Могилёв-1')
    expect(url.searchParams.get('from_exp')).toBe('2100000')
    expect(url.searchParams.get('to_exp')).toBe('2100150')
    const forward = new URL(bzdRouteUrl('mogilev-minsk', '2026-07-13'))
    expect(forward.searchParams.get('from_exp')).toBe('2100150')
    expect(forward.searchParams.get('to_exp')).toBe('2100000')
    expect(forward.searchParams.get('date')).toBe('2026-07-13')
  })

  it('accepts a valid response slower than the shared 12-second deadline', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-07-13T00:00:00Z'))
    vi.stubGlobal('fetch', vi.fn((url: string, init: RequestInit) => new Promise<Response>((resolve, reject) => {
      const reversed = new URL(url).searchParams.get('from_exp') === '2100000'
      const html = reversed ? row.replace('train-from-name">Могилёв-1', 'train-from-name">Минск-Пассажирский')
        .replace('train-to-name">Минск-Пассажирский', 'train-to-name">Могилёв-1') : row
      const timer = setTimeout(() => resolve(new Response(html)), 16_000)
      init.signal?.addEventListener('abort', () => { clearTimeout(timer); reject(init.signal?.reason) }, { once: true })
    })))
    const pending = collectBzd(1)
    await vi.advanceTimersByTimeAsync(90_000)
    const result = await pending
    expect(result.health.status).toBe('ok')
    expect(result.health.coverage?.filter((item) => item.status === 'ok')).toHaveLength(2)
    expect(result.trips).toHaveLength(2)
  })

  it('keeps all six near dates when each first attempt times out before a slow successful retry', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-07-13T00:00:00Z'))
    const attempts = new Map<string, number>()
    vi.stubGlobal('fetch', vi.fn((url: string, init: RequestInit) => new Promise<Response>((resolve, reject) => {
      const attempt = (attempts.get(url) ?? 0) + 1
      attempts.set(url, attempt)
      const query = new URL(url).searchParams
      let html = row.replaceAll('2026-07-13', query.get('date')!)
      if (query.get('from_exp') === '2100000') html = html.replace('train-from-name">Могилёв-1', 'train-from-name">Минск-Пассажирский')
        .replace('train-to-name">Минск-Пассажирский', 'train-to-name">Могилёв-1')
      const timer = setTimeout(() => resolve(new Response(html)), attempt === 1 ? 35_000 : 16_000)
      init.signal?.addEventListener('abort', () => { clearTimeout(timer); reject(init.signal?.reason) }, { once: true })
    })))
    const pending = withSourceDeadline(collectionDeadline('bzd', 'near'), () => collectBzd(3))
    await vi.advanceTimersByTimeAsync(200_000)
    const result = await pending
    expect(result.health.status).toBe('ok')
    expect(result.health.coverage?.filter((item) => item.status === 'ok')).toHaveLength(6)
    expect(result.trips).toHaveLength(6)
    expect([...attempts.values()]).toEqual([2, 2, 2, 2, 2, 2])
  })

  it('recognises departed rows and leaves empty ticket prices unknown', () => {
    const departed = row.replace('sch-table__row-wrap js-row', 'js-row sch-table__row-wrap disabled')
      .replace('data-ticket_selling_allowed="true"', 'data-ticket_selling_allowed="false"')
      .replace('data-value="25.28"', 'data-value="0"')
    const trips = parseBzdHtml(`${departed}<footer>нет мест</footer>`, 'mogilev-minsk', '2026-07-13', '2026-07-13T20:00:00Z')
    expect(trips).toHaveLength(1)
    expect(trips[0]).toMatchObject({ price: null, availability: 'unknown', departureAt: '2026-07-13T06:59:00+03:00' })
    expect(trips[0].bookingOptions[0].priceObservedAt).toBeUndefined()
  })

  it('rejects partial rows instead of confirming an incomplete result', () => {
    const broken = row.replace('train-from-time', 'changed-from-time')
    expect(() => parseBzdHtml(row + broken, 'mogilev-minsk', '2026-07-13', '2026-07-12T12:00:00Z')).toThrow('не распознана полностью')
    expect(() => parseBzdHtml(row.slice(0, -6), 'mogilev-minsk', '2026-07-13', '2026-07-12T12:00:00Z')).toThrow('повреждена')
  })
})
