import { describe, expect, it } from 'vitest'
import {
  DEFAULT_GAME_FILTER_RANGE,
  getGameFilterSettings,
  validateGameFilterRange
} from '@main/core/zapret-settings'

describe('validateGameFilterRange', () => {
  const valid: Array<[string, string | null]> = [
    ['1024-65535', '1024-65535'],
    ['1024-1934,1936-65535', '1024-1934,1936-65535'],
    ['  1024 - 65535  ', '1024-65535'],
    ['65535', '65535'],
    ['80', '80'],
    ['1-1', '1-1'],
    ['00080', '80']
  ]

  it.each(valid)('accepts %j as %j', (input, expected) => {
    expect(validateGameFilterRange(input)).toBe(expected)
  })

  const invalid: Array<[string, string | null]> = [
    ['0-65535', null],
    ['65536-65536', null],
    ['1-65536', null],
    ['2000-1000', null],
    ['0', null],
    ['abc', null],
    ['1024-abc', null],
    ['1024-', null],
    ['-1024', null],
    ['1024,', null],
    ['102400', null],
    ['', null],
    ['   ', null]
  ]

  it.each(invalid)('rejects %j', (input) => {
    expect(validateGameFilterRange(input)).toBeNull()
  })

  it('treats a missing value as invalid', () => {
    expect(validateGameFilterRange(undefined as unknown as string)).toBeNull()
  })
})

describe('getGameFilterSettings', () => {
  it('returns disabled defaults when no zapret config exists', () => {
    expect(getGameFilterSettings(undefined)).toEqual({
      mode: 'disabled',
      tcpRange: DEFAULT_GAME_FILTER_RANGE,
      udpRange: DEFAULT_GAME_FILTER_RANGE,
      enabled: false
    })
  })

  it('migrates the legacy gameFilter boolean to mode "all"', () => {
    expect(getGameFilterSettings({ enabled: true, gameFilter: true })).toMatchObject({
      mode: 'all',
      enabled: true
    })
  })

  it('keeps a valid explicit mode and ranges', () => {
    expect(
      getGameFilterSettings({
        enabled: true,
        gameFilter: true,
        gameFilterMode: 'tcp',
        gameFilterTcpRange: '1024-1934,1936-65535',
        gameFilterUdpRange: '2000-3000'
      })
    ).toEqual({
      mode: 'tcp',
      tcpRange: '1024-1934,1936-65535',
      udpRange: '2000-3000',
      enabled: true
    })
  })

  it('falls back to the default ranges when the stored values are corrupt', () => {
    expect(
      getGameFilterSettings({
        enabled: true,
        gameFilter: true,
        gameFilterTcpRange: 'nope',
        gameFilterUdpRange: '65536-65536'
      })
    ).toMatchObject({
      mode: 'all',
      tcpRange: DEFAULT_GAME_FILTER_RANGE,
      udpRange: DEFAULT_GAME_FILTER_RANGE
    })
  })

  it('prefers an explicit disabled mode over the legacy boolean', () => {
    expect(
      getGameFilterSettings({ enabled: true, gameFilter: true, gameFilterMode: 'disabled' })
    ).toMatchObject({ mode: 'disabled', enabled: false })
  })

  it('falls back to the legacy boolean when the stored mode is unknown', () => {
    expect(
      getGameFilterSettings({
        enabled: true,
        gameFilter: true,
        gameFilterMode: 'bogus' as never
      })
    ).toMatchObject({ mode: 'all', enabled: true })
  })
})
