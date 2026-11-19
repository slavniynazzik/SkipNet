/**
 * Review item: `appLog` must not read + YAML-parse `config.yaml` on every log
 * line. The redaction secret is cached and explicitly invalidated when the
 * config layer loads or rotates it.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  appLog,
  invalidateAppLogSecrets,
  setAppLogSecretProvider
} from '@main/utils/app-logger'

let secret = 'old-secret-value'
let reads = 0
let lines: string[] = []

beforeEach(() => {
  secret = 'old-secret-value'
  reads = 0
  lines = []
  setAppLogSecretProvider(() => {
    reads += 1
    return [secret]
  })
  vi.spyOn(console, 'log').mockImplementation((line: unknown) => {
    lines.push(String(line))
  })
})

afterEach(() => {
  setAppLogSecretProvider(null)
})

describe('appLog redaction cache', () => {
  it('resolves the secret once and masks it on every line', () => {
    appLog('info', 'proxy started token old-secret-value')
    appLog('info', 'proxy started token old-secret-value')

    expect(reads).toBe(1)
    expect(lines.at(-1)).toContain('<redacted>')
    expect(lines.at(-1)).not.toContain('old-secret-value')
  })

  it('masks a rotated secret immediately after invalidation', () => {
    appLog('info', 'token old-secret-value')
    expect(lines.at(-1)).toContain('<redacted>')

    // Rotation without invalidation keeps the old cached key: the new value is
    // not masked, which proves the cache is real.
    secret = 'rotated-secret-value'
    appLog('info', 'token rotated-secret-value')
    expect(reads).toBe(1)
    expect(lines.at(-1)).toContain('rotated-secret-value')

    invalidateAppLogSecrets()
    appLog('info', 'token rotated-secret-value')
    expect(reads).toBe(2)
    expect(lines.at(-1)).not.toContain('rotated-secret-value')
    expect(lines.at(-1)).toContain('<redacted>')
  })
})
