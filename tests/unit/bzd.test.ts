import { describe, expect, it } from 'vitest'
import { bzdRouteUrl, parseBzdHtml } from '../../scripts/sources/bzd'

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
    expect(url.searchParams.get('from')).toBe('Минск')
    expect(url.searchParams.get('to')).toBe('Могилев')
  })
})
