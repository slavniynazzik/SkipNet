import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { detectPortableDir } from '@main/utils/dirs'

const tempDirs: string[] = []

function tempDir(): string {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'skipnet-portable-'))
  tempDirs.push(dir)
  return dir
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

describe('detectPortableDir', () => {
  it('treats an explicit PORTABLE marker as portable', () => {
    const dir = tempDir()
    // Even next to the NSIS uninstaller: the marker wins.
    writeFileSync(path.join(dir, 'Uninstall SkipNet.exe'), '')
    writeFileSync(path.join(dir, 'PORTABLE'), '')
    expect(detectPortableDir(dir)).toBe(true)
  })

  it('treats a directory with an NSIS uninstaller as installed', () => {
    const dir = tempDir()
    writeFileSync(path.join(dir, 'Uninstall SkipNet.exe'), '')
    expect(detectPortableDir(dir)).toBe(false)
  })

  it('recognises the legacy lower-case uninstall.exe', () => {
    const dir = tempDir()
    writeFileSync(path.join(dir, 'uninstall.exe'), '')
    expect(detectPortableDir(dir)).toBe(false)
  })

  it('treats a directory with neither marker nor uninstaller as portable', () => {
    // This is exactly what the 7z target produces: no marker, no uninstaller.
    expect(detectPortableDir(tempDir())).toBe(true)
  })
})
