import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { appendLogLine, pruneLogFiles } from '@main/utils/app-logger'
import { logPath } from '@main/utils/dirs'

const tempDirs: string[] = []

function tempDir(): string {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'skipnet-logs-'))
  tempDirs.push(dir)
  return dir
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

describe('logPath', () => {
  it('names the file per day with zero-padded components', () => {
    const file = logPath(new Date(2026, 0, 5))
    expect(path.basename(file)).toBe('app-2026-01-05.log')
    expect(file.startsWith(logPath(new Date(2026, 0, 6)).replace(/app-.*$/, ''))).toBe(true)
  })
})

describe('appendLogLine', () => {
  it('creates the day file and appends one JSONL line at a time', async () => {
    const dir = tempDir()
    const date = new Date(2026, 10, 20)

    const file = await appendLogLine(dir, '{"one":1}', { date })
    await appendLogLine(dir, '{"two":2}', { date })

    expect(path.basename(file)).toBe('app-2026-11-20.log')
    expect(readFileSync(file, 'utf8')).toBe('{"one":1}\n{"two":2}\n')
  })

  it('rotates to .1 before the file exceeds the byte cap', async () => {
    const dir = tempDir()
    const date = new Date(2026, 10, 20)

    await appendLogLine(dir, 'first', { date, maxBytes: 10 })
    await appendLogLine(dir, 'second', { date, maxBytes: 10 })
    await appendLogLine(dir, 'third', { date, maxBytes: 10 })

    const active = path.join(dir, 'app-2026-11-20.log')
    const rotated = `${active}.1`
    expect(readFileSync(rotated, 'utf8')).toBe('second\n')
    expect(readFileSync(active, 'utf8')).toBe('third\n')
  })

  it('keeps writing even when the single line is larger than the cap', async () => {
    const dir = tempDir()
    const date = new Date(2026, 10, 20)
    const long = 'x'.repeat(50)

    await appendLogLine(dir, long, { date, maxBytes: 10 })
    expect(readFileSync(path.join(dir, 'app-2026-11-20.log'), 'utf8')).toBe(`${long}\n`)
  })
})

describe('pruneLogFiles', () => {
  it('removes day files older than maxDays, including their .1 rotation', async () => {
    const dir = tempDir()
    const day = (month: number, dayOfMonth: number): Date => new Date(2026, month - 1, dayOfMonth)

    await appendLogLine(dir, 'old', { date: day(11, 16) })
    await appendLogLine(dir, 'older', { date: day(10, 1) })
    await appendLogLine(dir, 'edge', { date: day(11, 18) })
    await appendLogLine(dir, 'today', { date: day(11, 20) })
    writeFileSync(path.join(dir, 'app-2026-11-16.log.1'), 'rotated\n')
    writeFileSync(path.join(dir, 'unrelated.txt'), 'keep me\n')

    const removed = await pruneLogFiles(dir, 3, day(11, 20))

    expect(removed.sort()).toEqual(
      ['app-2026-10-01.log', 'app-2026-11-16.log', 'app-2026-11-16.log.1'].sort()
    )
    expect(readdirSync(dir).sort()).toEqual(
      ['app-2026-11-18.log', 'app-2026-11-20.log', 'unrelated.txt'].sort()
    )
  })

  it('is a no-op for a missing directory', async () => {
    expect(await pruneLogFiles(path.join(tempDir(), 'missing'), 7)).toEqual([])
  })

  it('falls back to seven days for an invalid maxDays', async () => {
    const dir = tempDir()
    await appendLogLine(dir, 'old', { date: new Date(2026, 10, 1) })
    await pruneLogFiles(dir, Number.NaN, new Date(2026, 10, 20))
    expect(readdirSync(dir)).toEqual([])
  })
})
