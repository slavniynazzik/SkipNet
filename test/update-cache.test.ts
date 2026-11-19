import { readFileSync, rmSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { dataDir } from '@main/utils/dirs'
import { loadUpdateCache, saveUpdateCache } from '@main/utils/update-cache'

const written: string[] = []

function cacheFile(name: string): string {
  const file = path.join(dataDir(), `update-cache-${name}.json`)
  written.push(file)
  return file
}

function writeRaw(name: string, value: unknown): string {
  const file = cacheFile(name)
  writeFileSync(file, JSON.stringify(value), 'utf8')
  return file
}

afterEach(() => {
  for (const file of written.splice(0)) {
    try {
      rmSync(file, { force: true })
    } catch {
      /* noop */
    }
  }
})

describe('update cache trust boundary', () => {
  it('drops executable metadata from a tampered cache on load', () => {
    writeRaw('tampered', {
      at: Date.now(),
      data: {
        tag: 'v1.5.0',
        version: '1.5.0',
        hasUpdate: true,
        publishedAt: '2026-01-01T00:00:00Z',
        assetUrl: 'https://evil.example/SkipNet_x64.exe',
        assetDigest: `sha256:${'a'.repeat(64)}`,
        assetSize: 1337
      }
    })

    const loaded = loadUpdateCache('tampered')

    expect(loaded).not.toBeNull()
    expect(loaded?.data).toEqual({
      tag: 'v1.5.0',
      version: '1.5.0',
      hasUpdate: true,
      publishedAt: '2026-01-01T00:00:00Z'
    })
    expect(loaded?.data).not.toHaveProperty('assetUrl')
    expect(loaded?.data).not.toHaveProperty('assetDigest')
    expect(loaded?.data).not.toHaveProperty('assetSize')
  })

  it('clamps a future `at` timestamp to the current time', () => {
    const future = Date.now() + 7 * 24 * 60 * 60 * 1000
    writeRaw('future', {
      at: future,
      data: { tag: 'v1.5.0', version: '1.5.0', hasUpdate: true }
    })

    const loaded = loadUpdateCache('future')

    expect(loaded).not.toBeNull()
    expect(loaded?.at).toBeLessThanOrEqual(Date.now())
  })

  it('drops non-string and unknown fields from every persisted payload', () => {
    saveUpdateCache('sanitize-save', {
      tag: 'v1.5.0',
      version: '1.5.0',
      hasUpdate: true,
      releaseNotes: 'notes',
      // Legacy / hostile extras must never reach disk.
      assetUrl: 'https://evil.example/x.exe',
      assetDigest: `sha256:${'b'.repeat(64)}`,
      assetSize: 42,
      repo: 'evil/repo'
    } as never)

    const raw = JSON.parse(readFileSync(cacheFile('sanitize-save'), 'utf8')) as {
      data: Record<string, unknown>
    }

    expect(raw.data).toEqual({
      tag: 'v1.5.0',
      version: '1.5.0',
      hasUpdate: true,
      releaseNotes: 'notes'
    })
  })

  it('caps releaseNotes at 20 000 chars on save and load', () => {
    const huge = 'x'.repeat(20_000 + 500)
    saveUpdateCache('huge-notes', { tag: 'v1.5.0', version: '1.5.0', releaseNotes: huge })

    const saved = JSON.parse(readFileSync(cacheFile('huge-notes'), 'utf8')) as {
      data: { releaseNotes: string }
    }
    expect(saved.data.releaseNotes).toHaveLength(20_000)

    // A hostile cache written by another process is clamped on load too.
    writeRaw('huge-notes-read', {
      at: Date.now(),
      data: { tag: 'v1.5.0', version: '1.5.0', releaseNotes: huge }
    })
    expect(loadUpdateCache('huge-notes-read')?.data.releaseNotes).toHaveLength(20_000)
  })

  it('returns null for malformed or non-object cache files', () => {
    const file = cacheFile('broken')
    writeFileSync(file, '{not json', 'utf8')
    expect(loadUpdateCache('broken')).toBeNull()

    writeRaw('no-data', { at: Date.now(), data: 'v1.5.0' })
    expect(loadUpdateCache('no-data')).toBeNull()

    writeRaw('empty-data', { at: Date.now(), data: {} })
    expect(loadUpdateCache('empty-data')).toBeNull()
  })

  it('never writes a cache file when there is nothing inert to store', () => {
    saveUpdateCache('nothing', {} as never)
    expect(() => readFileSync(cacheFile('nothing'), 'utf8')).toThrow()
  })
})
