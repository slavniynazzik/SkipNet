import { describe, expect, it } from 'vitest'
import { compareVersion } from '../src/shared/version'

describe('compareVersion', () => {
  it('compares numeric segments numerically', () => {
    expect(compareVersion('1.10.0', '1.9.9')).toBe(1)
    expect(compareVersion('1.9.9', '1.10.0')).toBe(-1)
    expect(compareVersion('0.0.10', '0.0.9')).toBe(1)
  })

  it('accepts an optional v prefix', () => {
    expect(compareVersion('v1.2.3', '1.2.3')).toBe(0)
    expect(compareVersion('V2.0.0', 'v1.9.9')).toBe(1)
  })

  it('sorts prereleases below the matching release', () => {
    expect(compareVersion('2.0.0-beta', '2.0.0')).toBe(-1)
    expect(compareVersion('2.0.0', '2.0.0-rc.1')).toBe(1)
    expect(compareVersion('1.0.0-rc.1', '1.0.0-rc.2')).toBe(-1)
  })

  it('orders prerelease identifiers per SemVer', () => {
    expect(compareVersion('1.0.0-alpha', '1.0.0-alpha.1')).toBe(-1)
    expect(compareVersion('1.0.0-alpha.1', '1.0.0-alpha.beta')).toBe(-1)
    expect(compareVersion('1.0.0-alpha.beta', '1.0.0-beta')).toBe(-1)
    expect(compareVersion('1.0.0-beta.2', '1.0.0-beta.11')).toBe(-1)
    expect(compareVersion('1.0.0-rc.1', '1.0.0')).toBe(-1)
  })

  it('ignores build metadata', () => {
    expect(compareVersion('1.0.0+build.5', '1.0.0')).toBe(0)
    expect(compareVersion('1.0.0+aaa', '1.0.0+zzz')).toBe(0)
    expect(compareVersion('1.0.0-rc.1+sha.abc', '1.0.0-rc.1+sha.def')).toBe(0)
  })

  it('returns 0 for equal versions', () => {
    expect(compareVersion('1.4.0', '1.4.0')).toBe(0)
    expect(compareVersion(' 1.4.0 ', 'v1.4.0')).toBe(0)
  })

  it('treats malformed input as older than a valid version', () => {
    expect(compareVersion('not-a-version', '1.0.0')).toBe(-1)
    expect(compareVersion('1.0.0', 'garbage')).toBe(1)
    expect(compareVersion('garbage', 'garbage')).toBe(0)
    expect(compareVersion('', '1.0.0')).toBe(-1)
  })

  it('compares the same prerelease shape consistently', () => {
    expect(compareVersion('1.7.7-beta', '1.7.7-beta')).toBe(0)
    expect(compareVersion('1.7.7-beta', '1.7.7')).toBe(-1)
  })
})
