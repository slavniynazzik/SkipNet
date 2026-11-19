import { mkdtempSync, writeFileSync, rmSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  assertAutoRunTarget,
  buildTaskXml,
  currentUserId,
  escapeXml
} from '@main/sys/autoRun'

const tempDirs: string[] = []

function tempDir(): string {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'skipnet-autorun-'))
  tempDirs.push(dir)
  return dir
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

/** Every raw `&` must start a known XML entity. */
function hasOnlyValidEntities(xml: string): boolean {
  for (let i = 0; i < xml.length; i += 1) {
    if (xml[i] !== '&') continue
    if (!/^&(amp|lt|gt|quot|apos);/.test(xml.slice(i))) return false
  }
  return true
}

describe('escapeXml', () => {
  it('escapes every XML metacharacter', () => {
    expect(escapeXml('& < > " \'')).toBe('&amp; &lt; &gt; &quot; &apos;')
  })

  it('leaves non-ASCII text intact', () => {
    expect(escapeXml('C:\\Пользователи\\Иван & Ко')).toBe(
      'C:\\Пользователи\\Иван &amp; Ко'
    )
  })

  it('escapes the ampersand exactly once', () => {
    expect(escapeXml('&amp;')).toBe('&amp;amp;')
  })

  it('produces XML with no bare ampersands', () => {
    expect(hasOnlyValidEntities(escapeXml('a & b < c > d " e \' f'))).toBe(true)
  })
})

describe('buildTaskXml', () => {
  it('escapes an install path containing an ampersand', () => {
    const xml = buildTaskXml('C:\\R&D\\SkipNet\\SkipNet.exe', 'WORKSTATION\\user')
    expect(xml).toContain('<Command>C:\\R&amp;D\\SkipNet\\SkipNet.exe</Command>')
    expect(xml).not.toContain('C:\\R&D')
    expect(hasOnlyValidEntities(xml)).toBe(true)
  })

  it('escapes the user id in both trigger and principal', () => {
    const xml = buildTaskXml(
      'C:\\Program Files\\SkipNet\\SkipNet.exe',
      'DOMAIN\\o&brien "the admin"'
    )
    expect(xml).toContain('<UserId>DOMAIN\\o&amp;brien &quot;the admin&quot;</UserId>')
    expect(xml.match(/DOMAIN\\o&amp;brien/g)).toHaveLength(2)
    expect(hasOnlyValidEntities(xml)).toBe(true)
  })

  it('keeps the run level and single-instance policy', () => {
    const xml = buildTaskXml('C:\\SkipNet\\SkipNet.exe', 'PC\\user')
    expect(xml).toContain('<RunLevel>HighestAvailable</RunLevel>')
    expect(xml).toContain('<MultipleInstancesPolicy>IgnoreNew</MultipleInstancesPolicy>')
    expect(xml).toContain('<?xml version="1.0" encoding="UTF-16"?>')
  })

  it('survives a path with XML-escaped characters end to end', () => {
    const xml = buildTaskXml('C:\\Tools & <Utils>\\SkipNet.exe', 'PC\\user & co')
    // Round-tripping through the entity decoder must give the original values.
    const decoded = xml
      .replace(/&lt;/g, '<')
      .replace(/&gt;/g, '>')
      .replace(/&quot;/g, '"')
      .replace(/&apos;/g, "'")
      .replace(/&amp;/g, '&')
    expect(decoded).toContain('<Command>C:\\Tools & <Utils>\\SkipNet.exe</Command>')
    expect(decoded).toContain('<UserId>PC\\user & co</UserId>')
  })
})

describe('currentUserId', () => {
  it('joins domain and user without a leading separator', () => {
    expect(currentUserId({ USERDOMAIN: 'PC', USERNAME: 'neo' } as NodeJS.ProcessEnv)).toBe(
      'PC\\neo'
    )
    expect(currentUserId({ USERNAME: 'neo' } as NodeJS.ProcessEnv)).toBe('neo')
  })
})

describe('assertAutoRunTarget', () => {
  it('rejects a relative path with a Russian explanation', () => {
    expect(() => assertAutoRunTarget('SkipNet.exe')).toThrow(/абсолютным/)
  })

  it('rejects a missing absolute path', () => {
    const missing = path.join(tempDir(), 'nope', 'SkipNet.exe')
    expect(path.isAbsolute(missing)).toBe(true)
    expect(() => assertAutoRunTarget(missing)).toThrow(/не найден/)
  })

  it('accepts an existing absolute exe', () => {
    const dir = tempDir()
    const exe = path.join(dir, 'SkipNet.exe')
    writeFileSync(exe, '')
    expect(() => assertAutoRunTarget(exe)).not.toThrow()
  })
})
