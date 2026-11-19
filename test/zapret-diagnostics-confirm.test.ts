import { describe, expect, it } from 'vitest'
import {
  clearDiscordCache,
  fixTcpTimestamps,
  fixWindivertConflict,
  previewDiagnosticFix,
  removeConflictingBypasses
} from '@main/core/zapret-diagnostics'

/**
 * C9 / audit P1-12: diagnostics that delete services, flip a global TCP
 * setting or wipe a user's Discord cache must be no-ops unless the renderer
 * passes `{ confirmed: true }` after showing the exact action list.
 */
describe('destructive diagnostics require confirmation', () => {
  it('refuses the global TCP timestamps change without confirmed: true', () => {
    const result = fixTcpTimestamps()

    expect(result.ok).toBe(false)
    expect(result.message).toMatch(/подтвержд/i)
    expect(result.actions?.[0]?.kind).toBe('command')
    expect(result.actions?.[0]?.target).toBe(
      'netsh interface tcp set global timestamps=enabled'
    )
    // The preview states the previous global value, not just "will enable".
    expect(result.actions?.[0]?.details).toMatch(/Предыдущее состояние TCP timestamps/)
  })

  it('refuses to delete conflicting services without confirmed: true', () => {
    const result = removeConflictingBypasses()

    expect(result.ok).toBe(false)
    expect(result.message).toMatch(/подтвержд|нечего/i)
    expect(Array.isArray(result.actions)).toBe(true)
  })

  it('refuses to delete the WinDivert service without confirmed: true', () => {
    const result = fixWindivertConflict()

    expect(result.ok).toBe(false)
    expect(result.message).toMatch(/подтвержд|нечего/i)
  })

  it('refuses to kill Discord / wipe its cache without confirmed: true', () => {
    const result = clearDiscordCache()

    expect(result.ok).toBe(false)
    expect(result.closed).toEqual([])
    expect(result.cleared).toEqual([])
    expect(result.failed).toEqual([])
    expect(result.message).toMatch(/подтвержд|нечего/i)
  })
})

describe('diagnostic action previews', () => {
  it('describes a command fix without executing it', () => {
    const actions = previewDiagnosticFix('tcpTimestamps')

    expect(actions).toHaveLength(1)
    expect(actions[0]).toMatchObject({ kind: 'command' })
  })

  it('only lists service deletions that would actually happen', () => {
    for (const action of previewDiagnosticFix('conflictingBypasses')) {
      expect(action.kind).toBe('service')
      expect(action.target.length).toBeGreaterThan(0)
      expect(action.details.length).toBeGreaterThan(0)
    }
  })
})
