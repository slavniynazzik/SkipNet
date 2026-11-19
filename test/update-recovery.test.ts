/**
 * Pure unit tests for the two renderer recovery rules added for update checks:
 *
 * - `expectedTagFromError` parses the tag out of main's tag-mismatch install
 *   rejection so the hook can refresh the banner and let a second click work.
 * - `resolveUpdateInfo` decides whether the session's manual check result is
 *   rendered when automatic checks are disabled.
 *
 * `lib/update-check.ts` deliberately has no React/SWR imports, so these run in
 * the plain node vitest environment.
 */
import { describe, expect, it } from 'vitest'
import {
  expectedTagFromError,
  resolveUpdateInfo,
  updateBannerVisible
} from '../src/renderer/src/lib/update-check'

function mismatchError(tag: string): Error {
  return new Error(
    `Запрошенная версия не совпадает с последней проверенной (${tag}) — обновите список обновлений`
  )
}

describe('expectedTagFromError', () => {
  it('extracts the tag main will accept on the next install attempt', () => {
    expect(expectedTagFromError(mismatchError('v1.5.0'))).toBe('v1.5.0')
    expect(expectedTagFromError(mismatchError('1.5.0'))).toBe('1.5.0')
  })

  it('accepts the message as a plain string (IPC rejections are not always Errors)', () => {
    expect(expectedTagFromError(mismatchError('v2.0.1').message)).toBe('v2.0.1')
    expect(expectedTagFromError({ message: mismatchError('v2.0.1').message })).toBe('v2.0.1')
  })

  it('returns undefined when the message carries no expected tag', () => {
    expect(
      expectedTagFromError(
        new Error(
          'Запрошенная версия не совпадает с последней проверенной — обновите список обновлений'
        )
      )
    ).toBeUndefined()
  })

  it('ignores every other IPC/install failure', () => {
    expect(expectedTagFromError(new Error('Не удалось скачать архив: HTTP 502'))).toBeUndefined()
    expect(expectedTagFromError(new Error('Релиз v1.5.0 не найден на GitHub'))).toBeUndefined()
    expect(expectedTagFromError(undefined)).toBeUndefined()
    expect(expectedTagFromError(null)).toBeUndefined()
    expect(expectedTagFromError({})).toBeUndefined()
    expect(expectedTagFromError(42)).toBeUndefined()
  })

  it('rejects values main would never interpolate into an API path', () => {
    expect(expectedTagFromError(mismatchError('../../evil'))).toBeUndefined()
    expect(expectedTagFromError(mismatchError('v1.5.0-nightly'))).toBeUndefined()
    expect(expectedTagFromError(mismatchError('latest'))).toBeUndefined()
  })
})

describe('resolveUpdateInfo (manual result visibility)', () => {
  const shared = { hasUpdate: true, tag: 'v1.4.0', latest: '1.4.0' }
  const manual = { hasUpdate: true, tag: 'v1.5.0', latest: '1.5.0' }

  it('prefers the manual result while automatic checks are off', () => {
    // The SWR key is null with the gate off, so the explicit check is the only
    // source of truth; a stale shared entry must not win.
    expect(resolveUpdateInfo(false, undefined, manual)).toBe(manual)
    expect(resolveUpdateInfo(false, shared, manual)).toBe(manual)
  })

  it('prefers the shared cache while automatic checks are on', () => {
    expect(resolveUpdateInfo(true, shared, manual)).toBe(shared)
    expect(resolveUpdateInfo(true, shared, undefined)).toBe(shared)
  })

  it('falls back to whichever source exists', () => {
    // The cache has not resolved yet, but the user already clicked Проверить.
    expect(resolveUpdateInfo(true, undefined, manual)).toBe(manual)
    // Gate just turned off after an automatic check; keep showing its result.
    expect(resolveUpdateInfo(false, shared, undefined)).toBe(shared)
    expect(resolveUpdateInfo(false, undefined, undefined)).toBeUndefined()
  })

  it('keeps a dismissed manual result hidden across navigation', () => {
    const dismissed = resolveUpdateInfo(false, undefined, { ...manual, dismissed: true })
    expect(updateBannerVisible(dismissed)).toBe(false)
    expect(updateBannerVisible(resolveUpdateInfo(false, undefined, manual))).toBe(true)
  })
})
