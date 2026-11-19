import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs'
import os from 'os'
import path from 'path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  BinaryIntegrityError,
  MANIFEST_NAME,
  collectComponentExecutableFiles,
  parseManifestText,
  resolveContainedPath,
  updateManifestEntries,
  verifyFile,
  verifyTgwsBinary,
  verifyZapretBundle
} from '@main/core/binary-integrity'

let root: string

function write(relative: string, content: string): void {
  const file = path.join(root, ...relative.split('/'))
  mkdirSync(path.dirname(file), { recursive: true })
  writeFileSync(file, content)
}

function buildFixture(): void {
  root = mkdtempSync(path.join(os.tmpdir(), 'skipnet-integrity-'))
  write('zapret/bin/winws.exe', 'MZ fake winws')
  write('zapret/bin/WinDivert64.sys', 'fake driver')
  write('zapret/bin/WinDivert.dll', 'fake dll')
  write('zapret/general.bat', '@echo off\r\nbin\\winws.exe\r\n')
  write('zapret/utils/test zapret.ps1', 'Write-Host test')
  write('tgws/TgWsProxy_windows.exe', 'MZ fake tgws')

  updateManifestEntries(root, [
    ...collectComponentExecutableFiles(root, path.join(root, 'zapret')),
    ...collectComponentExecutableFiles(root, path.join(root, 'tgws'))
  ])
}

beforeEach(() => {
  buildFixture()
})

afterEach(() => {
  rmSync(root, { recursive: true, force: true })
})

describe('manifest parsing and path containment', () => {
  it('rejects traversal and absolute paths', () => {
    expect(() => resolveContainedPath(root, '../outside.exe')).toThrow(BinaryIntegrityError)
    expect(() => resolveContainedPath(root, 'zapret/../../outside.exe')).toThrow(
      BinaryIntegrityError
    )
    expect(() => resolveContainedPath(root, 'C:\\Windows\\system32\\cmd.exe')).toThrow(
      /абсолютный/
    )
    expect(() => resolveContainedPath(root, '/etc/passwd')).toThrow(/абсолютный/)
  })

  it('parses sha256sum format and rejects malformed lines', () => {
    const digest = 'a'.repeat(64)

    expect(parseManifestText(`${digest}  zapret/bin/winws.exe\n`)).toEqual({
      'zapret/bin/winws.exe': digest
    })
    expect(parseManifestText(`# comment\n${digest} *tgws/TgWsProxy_windows.exe\n`)).toEqual({
      'tgws/TgWsProxy_windows.exe': digest
    })
    expect(() => parseManifestText('not a manifest')).toThrow(/некорректная строка/)
    expect(() => parseManifestText('')).toThrow(/пуст/)
  })
})

describe('verifyZapretBundle / verifyTgwsBinary', () => {
  it('accepts an intact bundle generated from the same files', () => {
    expect(() => verifyZapretBundle(path.join(root, 'zapret'))).not.toThrow()
    expect(() => verifyTgwsBinary(path.join(root, 'tgws', 'TgWsProxy_windows.exe'))).not.toThrow()
  })

  it('rejects a single tampered byte in winws.exe', () => {
    write('zapret/bin/winws.exe', 'MZ fake winws!')

    expect(() => verifyZapretBundle(path.join(root, 'zapret'))).toThrow(/winws\.exe/)
    expect(() => verifyZapretBundle(path.join(root, 'zapret'))).toThrow(/изменён или повреждён/)
  })

  it('rejects a tampered TgWsProxy binary', () => {
    write('tgws/TgWsProxy_windows.exe', 'MZ fake tgwz')

    expect(() => verifyTgwsBinary(path.join(root, 'tgws', 'TgWsProxy_windows.exe'))).toThrow(
      /TgWsProxy_windows\.exe/
    )
  })

  it('rejects a strategy that is not covered by the manifest', () => {
    write('zapret/general (EVIL).bat', '@echo off\r\ncalc.exe\r\n')

    expect(() => verifyZapretBundle(path.join(root, 'zapret'))).toThrow(/не описан/)
  })

  it('rejects a missing file listed in the manifest', () => {
    rmSync(path.join(root, 'zapret', 'bin', 'WinDivert.dll'))

    expect(() => verifyZapretBundle(path.join(root, 'zapret'))).toThrow(/WinDivert\.dll/)
  })

  it('fails closed when the manifest is missing', () => {
    rmSync(path.join(root, MANIFEST_NAME))

    expect(() => verifyZapretBundle(path.join(root, 'zapret'))).toThrow(/binaries\.sha256/)
    expect(() => verifyFile(root, 'zapret/bin/winws.exe')).toThrow(/binaries\.sha256/)
  })
})

describe('updateManifestEntries', () => {
  it('prunes stale entries for files removed by an update', () => {
    const bundle = path.join(root, 'zapret')
    const withAlt = path.join(bundle, 'general (ALT).bat')
    writeFileSync(withAlt, '@echo off\r\n')
    updateManifestEntries(root, collectComponentExecutableFiles(root, bundle))

    expect(() => verifyZapretBundle(bundle)).not.toThrow()

    rmSync(withAlt)
    updateManifestEntries(root, collectComponentExecutableFiles(root, bundle))

    const manifest = parseManifestText(
      readFileSync(path.join(root, MANIFEST_NAME), 'utf8')
    )
    expect(manifest['zapret/general (ALT).bat']).toBeUndefined()
    expect(() => verifyZapretBundle(bundle)).not.toThrow()
  })
})

describe('bundled resources', () => {
  // Guards against shipping a stale manifest: if resources/*.exe / *.bat
  // change without running `node scripts/build-binary-manifest.mjs`, the
  // packaged app would fail its own integrity check on first launch.
  it('matches the checked-in manifest', () => {
    const resources = path.join(process.cwd(), 'resources')

    expect(() => verifyZapretBundle(path.join(resources, 'zapret'))).not.toThrow()
    expect(() =>
      verifyTgwsBinary(path.join(resources, 'tgws', 'TgWsProxy_windows.exe'))
    ).not.toThrow()
  })
})
