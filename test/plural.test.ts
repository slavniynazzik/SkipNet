import { describe, expect, it } from 'vitest'
import { pluralRu } from '../src/renderer/src/lib/plural'

describe('pluralRu', () => {
  const forms = ['сервис', 'сервиса', 'сервисов'] as const

  it('uses the singular form for 1, 21, 101', () => {
    expect(pluralRu(1, forms)).toBe('сервис')
    expect(pluralRu(21, forms)).toBe('сервис')
    expect(pluralRu(101, forms)).toBe('сервис')
  })

  it('uses the paucal form for 2-4 and 22-24', () => {
    expect(pluralRu(2, forms)).toBe('сервиса')
    expect(pluralRu(4, forms)).toBe('сервиса')
    expect(pluralRu(23, forms)).toBe('сервиса')
  })

  it('uses the plural form for 0, 5-20 and 11-14', () => {
    expect(pluralRu(0, forms)).toBe('сервисов')
    expect(pluralRu(5, forms)).toBe('сервисов')
    expect(pluralRu(11, forms)).toBe('сервисов')
    expect(pluralRu(14, forms)).toBe('сервисов')
    expect(pluralRu(25, forms)).toBe('сервисов')
  })

  it('handles negatives and fractions deterministically', () => {
    expect(pluralRu(-1, forms)).toBe('сервис')
    expect(pluralRu(2.9, forms)).toBe('сервиса')
  })
})
