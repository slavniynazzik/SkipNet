import {
  existsSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  utimesSync,
  writeFileSync
} from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  HOSTS_TEMP_MAX_AGE_MS,
  buildElevatedHostsWriteScript,
  isStaleHostsTempFile,
  resetHostsTempSweepForTesting,
  sweepStaleHostsTemps,
  writeHostsContentTo
} from '@main/core/hosts-file'

const tempDirs: string[] = []

function tempDir(): string {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'skipnet-hosts-'))
  tempDirs.push(dir)
  return dir
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

describe('buildElevatedHostsWriteScript', () => {
  const script = buildElevatedHostsWriteScript(
    'C:\\ProgramData\\SkipNet\\hosts\\payload.txt',
    'C:\\Windows\\System32\\drivers\\etc\\hosts',
    'a'.repeat(64)
  )

  it('reads the staged payload exactly once and hashes those bytes in memory', () => {
    expect(script.match(/ReadAllBytes/g)).toHaveLength(1)
    // Get-FileHash would be a second read after the hash was computed.
    expect(script).not.toContain('Get-FileHash')
    expect(script).toContain('$bytes = [IO.File]::ReadAllBytes(')
    expect(script).toContain('ComputeHash($bytes)')
  })

  it('writes the same bytes to a temp file in the target directory and fsyncs', () => {
    expect(script).toContain("[IO.Path]::GetDirectoryName($target)")
    expect(script).toContain('[IO.FileMode]::CreateNew')
    expect(script).toContain('$fs.Write($bytes, 0, $bytes.Length)')
    expect(script).toContain('$fs.Flush($true)')
    expect(script).toContain('Move-Item -LiteralPath $tmp -Destination $target -Force')
  })

  it('propagates a checksum mismatch and a failed replace as non-zero exits', () => {
    expect(script).toContain("Write-Error 'hosts checksum mismatch'")
    expect(script.match(/exit 1/g)?.length).toBeGreaterThanOrEqual(2)
    expect(script).toContain('exit 0')
  })
})

describe('stale hosts temp sweep (W15)', () => {
  const now = 1_700_000_000_000
  const name = 'hosts.skipnet-0123456789abcdef.tmp'

  it('accepts only SkipNet temp files inside the hosts directory', () => {
    const dir = tempDir()
    const old = now - HOSTS_TEMP_MAX_AGE_MS - 1

    expect(isStaleHostsTempFile(path.join(dir, name), dir, old, now)).toBe(true)
    // Fresh temp files may belong to a write that is still running.
    expect(isStaleHostsTempFile(path.join(dir, name), dir, now - 1000, now)).toBe(false)
    // Different directory, different name, invalid mtime.
    expect(
      isStaleHostsTempFile(path.join(tempDir(), name), dir, old, now)
    ).toBe(false)
    expect(isStaleHostsTempFile(path.join(dir, 'hosts'), dir, old, now)).toBe(false)
    expect(isStaleHostsTempFile(path.join(dir, 'hosts.skipnet-x.tmp.bak'), dir, old, now)).toBe(
      false
    )
    expect(isStaleHostsTempFile(path.join(dir, name), dir, Number.NaN, now)).toBe(false)
  })

  it('removes old temp files once and keeps fresh ones', () => {
    const dir = tempDir()
    const stale = path.join(dir, 'hosts.skipnet-aaaaaaaa.tmp')
    const fresh = path.join(dir, 'hosts.skipnet-bbbbbbbb.tmp')
    writeFileSync(stale, 'old')
    writeFileSync(fresh, 'new')
    const oldSeconds = (now - HOSTS_TEMP_MAX_AGE_MS - 60_000) / 1000
    utimesSync(stale, oldSeconds, oldSeconds)

    resetHostsTempSweepForTesting()
    expect(sweepStaleHostsTemps(dir, now)).toBe(1)
    expect(existsSync(stale)).toBe(false)
    expect(existsSync(fresh)).toBe(true)

    // The sweep is once per session.
    expect(sweepStaleHostsTemps(dir, now)).toBe(0)
  })
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
