import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  TELEGRAM_TASK_LINGER_MS,
  TELEGRAM_URL_MAX_LENGTH,
  buildTelegramCreateArgs,
  buildTelegramDeleteArgs,
  buildTelegramFallback,
  buildTelegramLaunchTask,
  buildTelegramRunArgs,
  buildTelegramTaskXml,
  describeTelegramError,
  escapeXml,
  isAllowedTelegramUrl,
  openTelegramLink,
  resetTelegramLaunchLockForTesting
} from '@main/utils/telegram-launch'

const PROXY_URL =
  'tg://proxy?server=proxy.example&port=443&secret=0123456789abcdef0123456789abcdef'
const SECRET = '0123456789abcdef0123456789abcdef'

let stagingDir: string

beforeEach(() => {
  resetTelegramLaunchLockForTesting()
  stagingDir = mkdtempSync(path.join(os.tmpdir(), 'skipnet-tg-'))
})

afterEach(() => {
  rmSync(stagingDir, { recursive: true, force: true })
})

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

describe('XML task definition', () => {
  it('escapes XML metacharacters', () => {
    expect(escapeXml(`<&>"'`)).toBe('&lt;&amp;&gt;&quot;&apos;')
    // `&` must be escaped first: `&amp;lt;` is the classic double-escape bug.
    expect(escapeXml('a&b<c')).toBe('a&amp;b&lt;c')
  })

  it('puts the URL into <Arguments> as escaped text, not into /TR', () => {
    const xml = buildTelegramTaskXml(PROXY_URL, 'SkipNet_test_task')
    expect(xml).toContain(`<Arguments>&quot;${PROXY_URL.replace(/&/g, '&amp;')}&quot;</Arguments>`)
    // A raw `&` would make the XML invalid, which schtasks rejects.
    expect(xml).not.toContain('server=proxy.example&port')
    expect(xml).not.toContain('-EncodedCommand')
    expect(xml).not.toContain('/TR')
  })

  it('runs explorer as the interactive user at the least-privilege level', () => {
    const xml = buildTelegramTaskXml(PROXY_URL, 'task')
    expect(xml).toContain('<Command>%SystemRoot%\\explorer.exe</Command>')
    expect(xml).toContain('<LogonType>InteractiveToken</LogonType>')
    expect(xml).toContain('<RunLevel>LeastPrivilege</RunLevel>')
    expect(xml).toContain('<Triggers />')
    expect(xml).toContain('<?xml version="1.0" encoding="UTF-16"?>')
  })

  it('builds schtasks arguments without /TR', () => {
    const create = buildTelegramCreateArgs('task', 'C:\\staging\\task.xml')
    expect(create).toEqual(['/Create', '/F', '/TN', 'task', '/XML', 'C:\\staging\\task.xml'])
    expect(create).not.toContain('/TR')
    expect(buildTelegramRunArgs('task')).toEqual(['/Run', '/TN', 'task'])
    expect(buildTelegramDeleteArgs('task')).toEqual(['/Delete', '/F', '/TN', 'task'])
  })
})

describe('buildTelegramLaunchTask', () => {
  it('generates a random task name by default', () => {
    const a = buildTelegramLaunchTask(PROXY_URL)
    const b = buildTelegramLaunchTask(PROXY_URL)
    expect(a.taskName).toMatch(/^SkipNet_OpenTG_/)
    expect(a.taskName).not.toBe(b.taskName)
  })

  it('escapes the task name as well', () => {
    const task = buildTelegramLaunchTask(PROXY_URL, 'a&b<c')
    expect(task.xml).toContain('<URI>\\a&amp;b&lt;c</URI>')
  })

  it('rejects control characters before rendering', () => {
    expect(() => buildTelegramLaunchTask('tg://proxy?x=\u0001', 't')).toThrow(/unsupported/)
  })

  it('rejects a bad scheme before rendering', () => {
    expect(() => buildTelegramLaunchTask('https://evil.example', 't')).toThrow(/unsupported/)
  })
})

describe('fallback', () => {
  it('spawns explorer with the URL (the shell de-elevates it)', () => {
    const fallback = buildTelegramFallback(PROXY_URL)
    expect(fallback.file.toLowerCase().endsWith('explorer.exe')).toBe(true)
    expect(fallback.args).toEqual([PROXY_URL])
  })

  it('uses explorer when schtasks refuses the task', async () => {
    const spawned: Array<{ file: string; args: string[] }> = []
    const logs: string[] = []
    await openTelegramLink(PROXY_URL, {
      platform: 'win32',
      stagingDir: () => stagingDir,
      exec: async (_file, args) => {
        if (args[0] === '/Create') {
          throw Object.assign(new Error(`Command failed: ${PROXY_URL}`), {
            code: 1,
            stderr: 'Access is denied.'
          })
        }
      },
      spawnFallback: (file, args) => spawned.push({ file, args }),
      sleep: async () => undefined,
      log: (line) => logs.push(line)
    })

    expect(spawned).toHaveLength(1)
    expect(spawned[0].file.toLowerCase().endsWith('explorer.exe')).toBe(true)
    expect(spawned[0].args).toEqual([PROXY_URL])
    expect(logs.join('\n')).not.toContain(PROXY_URL)
    expect(logs.join('\n')).not.toContain(SECRET)
  })
})

describe('openTelegramLink task lifecycle', () => {
  it('stages XML, runs the task, lingers and deletes it', async () => {
    const calls: Array<{ file: string; args: string[] }> = []
    const sleeps: number[] = []
    const logs: string[] = []
    let stagedXml = ''

    await openTelegramLink(PROXY_URL, {
      platform: 'win32',
      stagingDir: () => stagingDir,
      exec: async (file, args) => {
        calls.push({ file, args })
        if (args[0] === '/Create') {
          const xmlPath = args[args.indexOf('/XML') + 1]
          stagedXml = readFileSync(xmlPath, 'utf16le')
        }
      },
      sleep: async (ms) => {
        sleeps.push(ms)
      },
      log: (line) => logs.push(line)
    })

    expect(calls).toHaveLength(3)
    expect(calls[0].args[0]).toBe('/Create')
    expect(calls[0].args).toContain('/XML')
    expect(calls[0].args.some((arg) => arg === '/TR')).toBe(false)

    const xmlPath = calls[0].args[calls[0].args.indexOf('/XML') + 1]
    expect(stagedXml).toContain('<Command>%SystemRoot%\\explorer.exe</Command>')
    expect(stagedXml).toContain('&quot;tg://proxy?server=proxy.example&amp;port=443')
    // The staged definition is removed after the task is deleted.
    expect(existsSync(xmlPath)).toBe(false)

    expect(calls[1].args[0]).toBe('/Run')
    // Never delete in the same tick as /Run.
    expect(sleeps).toEqual([TELEGRAM_TASK_LINGER_MS])
    expect(calls[2].args.slice(0, 3)).toEqual(['/Delete', '/F', '/TN'])
    expect(logs).toEqual([])
  })

  it('still deletes the task when /Run fails', async () => {
    const calls: string[] = []
    await openTelegramLink(PROXY_URL, {
      platform: 'win32',
      stagingDir: () => stagingDir,
      exec: async (_file, args) => {
        calls.push(args[0])
        if (args[0] === '/Run') throw Object.assign(new Error('denied'), { code: 1 })
      },
      spawnFallback: () => undefined,
      sleep: async () => undefined,
      log: () => undefined
    })
    expect(calls).toEqual(['/Create', '/Run', '/Delete'])
  })

  it('ignores a second call inside the inflight window', async () => {
    const calls: string[] = []
    const hooks = {
      platform: 'win32' as const,
      stagingDir: () => stagingDir,
      exec: async (_file: string, args: string[]) => {
        calls.push(args[0])
      },
      sleep: async () => undefined,
      log: () => undefined
    }
    await openTelegramLink(PROXY_URL, hooks)
    await openTelegramLink(PROXY_URL, hooks)
    expect(calls.filter((arg) => arg === '/Create')).toHaveLength(1)
  })
})

describe('logging', () => {
  it('never prints the URL or the execFile message', () => {
    const error = Object.assign(new Error(`Command failed: schtasks ${PROXY_URL}`), {
      code: 'ETIMEDOUT',
      name: 'Error',
      stderr: `Access denied for ${PROXY_URL} secret=${SECRET}`
    })
    const line = describeTelegramError('schtasks', error, PROXY_URL)

    expect(line).toContain('code=ETIMEDOUT')
    expect(line).toContain('name=Error')
    expect(line).not.toContain(SECRET)
    expect(line).not.toContain('tg://')
  })

  it('prints only the stage when nothing redactable is available', () => {
    expect(describeTelegramError('rejected url', { name: 'unsupported' })).toBe(
      '[openTelegramLink] rejected url: name=unsupported'
    )
  })
})
