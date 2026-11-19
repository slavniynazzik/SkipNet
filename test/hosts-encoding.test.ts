import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  HOSTS_UTF16_ERROR,
  readHostsRawLenient,
  readHostsRawStrict,
  setHostsPathForTesting
} from '@main/core/hosts-file'

const tempDirs: string[] = []

function tempDir(): string {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'skipnet-hosts-enc-'))
  tempDirs.push(dir)
  return dir
}

function utf16Fixture(encoding: 'utf16le' | 'utf16be'): string {
  const dir = tempDir()
  const target = path.join(dir, 'hosts')
  // A realistic hosts file written by an editor that defaults to UTF-16.
  const content = '127.0.0.1 localhost\r\n# SkipNet UTF-16 fixture\r\n'
  const bom = encoding === 'utf16le' ? Buffer.from([0xff, 0xfe]) : Buffer.from([0xfe, 0xff])
  const body = Buffer.from(content, 'utf16le')
  // Swap byte order for the BE case; Node has no utf16be encoder.
  const bytes =
    encoding === 'utf16be'
      ? Buffer.concat([
          bom,
          Buffer.from(body.buffer, body.byteOffset, body.byteLength).swap16()
        ])
      : Buffer.concat([bom, body])
  writeFileSync(target, bytes)
  return target
}

afterEach(() => {
  setHostsPathForTesting(null)
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

describe('UTF-16 hosts rejection (H6)', () => {
  it('readHostsRawStrict throws a Russian ANSI/UTF-8 hint for a UTF-16LE BOM', () => {
    setHostsPathForTesting(utf16Fixture('utf16le'))
    expect(() => readHostsRawStrict()).toThrow(HOSTS_UTF16_ERROR)
    expect(HOSTS_UTF16_ERROR).toMatch(/UTF-16/)
    expect(HOSTS_UTF16_ERROR).toMatch(/ANSI|UTF-8/)
  })

  it('readHostsRawStrict throws for a UTF-16BE BOM', () => {
    setHostsPathForTesting(utf16Fixture('utf16be'))
    expect(() => readHostsRawStrict()).toThrow(/UTF-16/)
  })

  it('readHostsRawLenient reports a failed read instead of returning content', () => {
    setHostsPathForTesting(utf16Fixture('utf16le'))
    const read = readHostsRawLenient()
    expect(read.ok).toBe(false)
    expect(read.content).toBe('')
    expect(read.error).toMatch(/UTF-16/)
  })

  it('still accepts an ANSI/latin1 hosts file', () => {
    const dir = tempDir()
    const target = path.join(dir, 'hosts')
    writeFileSync(target, Buffer.from('127.0.0.1 localhost\r\n', 'latin1'))
    setHostsPathForTesting(target)
    expect(readHostsRawStrict()).toBe('127.0.0.1 localhost\r\n')
    expect(readHostsRawLenient()).toMatchObject({ ok: true })
  })
})
