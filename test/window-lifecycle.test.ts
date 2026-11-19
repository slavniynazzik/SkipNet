import { describe, expect, it } from 'vitest'
import { shouldQuitOnWindowAllClosed } from '@main/resolve/window-lifecycle'

describe('shouldQuitOnWindowAllClosed', () => {
  it('keeps running when the tray is active and enabled', () => {
    expect(shouldQuitOnWindowAllClosed(true, false)).toBe(false)
  })

  it('quits when the tray was disabled by the user', () => {
    expect(shouldQuitOnWindowAllClosed(true, true)).toBe(true)
  })

  it('quits when tray creation failed', () => {
    expect(shouldQuitOnWindowAllClosed(false, false)).toBe(true)
  })

  it('quits when both are set', () => {
    expect(shouldQuitOnWindowAllClosed(false, true)).toBe(true)
  })
})
