import { describe, expect, it } from 'vitest'
import { ACCESS_HASHES, hashAccessKey, isAccessHash, normalizeAccessKey } from '../../src/lib/access'

describe('access keys', () => {
  it('normalizes whitespace and letter case', () => {
    expect(normalizeAccessKey('  mm-abc-123  ')).toBe('MM-ABC-123')
  })

  it('hashes normalized keys consistently', async () => {
    expect(await hashAccessKey('  test-key  ')).toBe(await hashAccessKey('TEST-KEY'))
  })

  it('accepts only configured grants', () => {
    expect(isAccessHash(ACCESS_HASHES[0])).toBe(true)
    expect(isAccessHash('not-an-access-hash')).toBe(false)
    expect(isAccessHash(null)).toBe(false)
  })
})
