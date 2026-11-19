import { describe, expect, it } from 'vitest'
import {
  TELEGRAM_URL_MAX_LENGTH,
  buildTelegramLaunchTask,
  buildTelegramTaskAction,
  isAllowedTelegramUrl
} from '@main/utils/telegram-launch'

const PROXY_URL = 'tg://proxy?server=proxy.example&port=443&secret=0123456789abcdef0123456789abcdef'

function decode(encodedCommand: string): string {
  return Buffer.from(encodedCommand, 'base64').toString('utf16le')
}

describe('isAllowedTelegramUrl', () => {
  it('accepts tg: and Telegram https links', () => {
    expect(isAllowedTelegramUrl(PROXY_URL)).toBe(true)
    expect(isAllowedTelegramUrl('https://t.me/skipnet')).toBe(true)
    expect(isAllowedTelegramUrl('https://telegram.me/skipnet')).toBe(true)
  })

  it('rejects other schemes and hosts', () => {
    expect(isAllowedTelegramUrl('javascript:alert(1)')).toBe(false)
    expect(isAllowedTelegramUrl('file:///C:/Windows/System32/cmd.exe')).toBe(false)
    expect(isAllowedTelegramUrl('https://evil.example/t.me')).toBe(false)
    expect(isAllowedTelegramUrl('https://t.me.evil.example/')).toBe(false)
    expect(isAllowedTelegramUrl('')).toBe(false)
  })

  it('rejects control characters', () => {
    expect(isAllowedTelegramUrl('tg://proxy?x=\u0000')).toBe(false)
    expect(isAllowedTelegramUrl('tg://proxy?x=\r\n')).toBe(false)
    expect(isAllowedTelegramUrl('tg://proxy?x=\u007F')).toBe(false)
  })

  it('caps the url length', () => {
    const long = `tg://proxy?secret=${'a'.repeat(TELEGRAM_URL_MAX_LENGTH)}`
    expect(long.length).toBeGreaterThan(TELEGRAM_URL_MAX_LENGTH)
    expect(isAllowedTelegramUrl(long)).toBe(false)
  })
})

describe('buildTelegramLaunchTask', () => {
  it('encodes a hidden Start-Process command without touching the disk', () => {
    const task = buildTelegramLaunchTask(PROXY_URL, 'SkipNet_test_task')
    expect(task.taskName).toBe('SkipNet_test_task')

    const script = decode(task.encodedCommand)
    expect(script).toContain(`Start-Process -FilePath '${PROXY_URL}'`)
    // Exactly one occurrence: the URL must not be duplicated into a comment or
    // a second argument.
    expect(script.split(PROXY_URL)).toHaveLength(2)
  })

  it('generates a random task name by default', () => {
    const a = buildTelegramLaunchTask(PROXY_URL)
    const b = buildTelegramLaunchTask(PROXY_URL)
    expect(a.taskName).toMatch(/^SkipNet_OpenTG_/)
    expect(a.taskName).not.toBe(b.taskName)
  })

  it('doubles single quotes so the URL cannot break the string literal', () => {
    const url = 'tg://proxy?server=it%27s&secret=abc'
    // The literal apostrophe is what matters for psQuote.
    const task = buildTelegramLaunchTask(url.replace('%27', "'"), 'task')
    const script = decode(task.encodedCommand)
    expect(script).toContain("Start-Process -FilePath 'tg://proxy?server=it''s&secret=abc'")
  })

  it('rejects control characters before encoding', () => {
    expect(() => buildTelegramLaunchTask('tg://proxy?x=\u0001', 't')).toThrow(/unsupported/)
  })

  it('rejects a bad scheme before encoding', () => {
    expect(() => buildTelegramLaunchTask('https://evil.example', 't')).toThrow(/unsupported/)
  })

  it('builds a /TR action with an absolute powershell executable', () => {
    const { encodedCommand } = buildTelegramLaunchTask(PROXY_URL, 't')
    const action = buildTelegramTaskAction(encodedCommand)
    expect(action).toMatch(/^"[A-Za-z]:\\.*powershell\.exe"/)
    expect(action).toContain('-EncodedCommand')
    expect(action).toContain(encodedCommand)
    expect(action).not.toContain(PROXY_URL)
  })
})
