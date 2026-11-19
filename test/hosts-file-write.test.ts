import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { writeHostsContentTo } from '@main/core/hosts-file'

const tempDirs: string[] = []

function tempDir(): string {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'skipnet-hosts-'))
  tempDirs.push(dir)
  return dir
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

describe('writeHostsContentTo (direct path)', () => {
  it('writes a new file atomically and leaves no temp file behind', () => {
    const dir = tempDir()
    const target = path.join(dir, 'hosts')
    const content = '127.0.0.1 localhost\r\n# comment\r\n'

    const result = writeHostsContentTo(target, content)

    expect(result).toMatchObject({ ok: true, elevated: false })
    expect(readFileSync(target).toString('latin1')).toBe(content)
    expect(readdirSync(dir)).toEqual(['hosts'])
  })

  it('replaces an existing file without a truncation window', () => {
    const dir = tempDir()
    const target = path.join(dir, 'hosts')
    writeFileSync(target, 'old content that is longer than the new one\r\n')

    const result = writeHostsContentTo(target, 'new\r\n')

    expect(result.ok).toBe(true)
    expect(readFileSync(target).toString('latin1')).toBe('new\r\n')
    expect(readdirSync(dir)).toEqual(['hosts'])
  })

  it('preserves latin1 bytes exactly', () => {
    const dir = tempDir()
    const target = path.join(dir, 'hosts')
    const content = '127.0.0.1 caf\u00e9.example\r\n'

    expect(writeHostsContentTo(target, content).ok).toBe(true)
    const raw = readFileSync(target)
    expect(raw.equals(Buffer.from(content, 'latin1'))).toBe(true)
  })
})
