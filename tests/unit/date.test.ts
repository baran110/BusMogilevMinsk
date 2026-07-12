import { describe, expect, it } from 'vitest'
import { addDays, formatDuration, formatUpdated, isDeparted, minskIso, reverseDirection } from '../../src/lib/date'

describe('date helpers', () => {
  it('keeps calendar arithmetic stable', () => {
    expect(addDays('2026-07-31', 1)).toBe('2026-08-01')
    expect(minskIso('2026-07-12', '09:30')).toBe('2026-07-12T09:30:00+03:00')
  })

  it('detects departed trips', () => {
    expect(isDeparted('2026-07-12T09:00:00+03:00', new Date('2026-07-12T07:00:00Z'))).toBe(true)
    expect(isDeparted('2026-07-12T11:00:00+03:00', new Date('2026-07-12T07:00:00Z'))).toBe(false)
  })

  it('formats duration and reverses route', () => {
    expect(formatDuration(150)).toBe('2 ч 30 мин')
    expect(reverseDirection('mogilev-minsk')).toBe('minsk-mogilev')
  })

  it('shows the full snapshot date and Minsk time', () => {
    expect(formatUpdated('2026-07-13T00:26:00Z')).toContain('13.07.2026')
    expect(formatUpdated('2026-07-13T00:26:00Z')).toContain('03:26')
  })
})
