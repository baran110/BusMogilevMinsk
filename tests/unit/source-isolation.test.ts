import { describe, expect, it } from 'vitest'
import { collectPairs } from '../../scripts/lib/coverage'
import { HttpError } from '../../scripts/lib/fetch'
import { fixtureTrip } from '../fixtures/schedule'

const source = { id: 'avtoslava', name: 'АвтоСлава', kind: 'carrier' as const, url: 'https://avto-slava.by/' }
describe('date failures preserve successful results and stop HTTP blocks', () => {
  it('keeps other dates and directions after one unrecognised date', async () => {
    const result = await collectPairs(source, [
      { direction: 'mogilev-minsk', date: '2026-10-15' }, { direction: 'minsk-mogilev', date: '2026-10-15' },
      { direction: 'mogilev-minsk', date: '2026-10-16' },
    ], async (direction, date) => {
      if (direction === 'mogilev-minsk' && date === '2026-10-15') throw new Error('Не распознана эта дата')
      return [fixtureTrip(date, direction)]
    })
    expect(result.trips).toHaveLength(2)
    expect(result.health.coverage?.filter((item) => item.status === 'ok')).toHaveLength(2)
    expect(result.health.status).toBe('stale')
  })
  it('does not send further requests after an HTTP ban', async () => {
    let calls = 0
    const pairs = Array.from({ length: 8 }, (_, i) => ({ direction: 'mogilev-minsk' as const, date: `2026-10-${15 + i}` }))
    const result = await collectPairs(source, pairs, async () => { calls++; throw new HttpError(403) })
    expect(calls).toBeLessThanOrEqual(2)
    expect(result.trips).toHaveLength(0)
    expect(result.health.coverage).toHaveLength(8)
  })
})
