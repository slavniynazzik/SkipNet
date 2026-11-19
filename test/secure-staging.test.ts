import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  productionStagingRoot,
  secureStagingDir,
  setStagingRootForTesting,
  stagingAclArgs,
  stagingPath
} from '@main/utils/secure-staging'

let root: string

beforeEach(() => {
  root = mkdtempSync(path.join(os.tmpdir(), 'skipnet-staging-'))
  setStagingRootForTesting(root)
})

afterEach(() => {
  setStagingRootForTesting(null)
  rmSync(root, { recursive: true, force: true })
})

describe('productionStagingRoot', () => {
  it('uses %ProgramData%\\SkipNet, never %TEMP%', () => {
    expect(productionStagingRoot({ ProgramData: 'C:\\ProgramData' })).toBe(
      'C:\\ProgramData\\SkipNet'
    )
  })

  it('honours a relocated ProgramData on another drive', () => {
    expect(productionStagingRoot({ ProgramData: 'D:\\CorpData' })).toBe(
      'D:\\CorpData\\SkipNet'
    )
  })

  it('falls back to %SystemDrive%\\ProgramData', () => {
    expect(productionStagingRoot({ SystemDrive: 'E:' })).toBe('E:\\ProgramData\\SkipNet')
  })

  it('fails closed when neither ProgramData nor SystemDrive is usable', () => {
    expect(() => productionStagingRoot({})).toThrow(/ProgramData/)
    expect(() => productionStagingRoot({ ProgramData: '\\\\server\\share' })).toThrow(
      /ProgramData/
    )
  })
})

describe('stagingPath', () => {
  it('builds <kind> directories below the staging root', () => {
    expect(stagingPath('updates')).toBe(path.join(root, 'updates'))
    expect(stagingPath('tasks', 'task.xml')).toBe(path.join(root, 'tasks', 'task.xml'))
  })

  it('rejects an unknown kind', () => {
    expect(() => stagingPath('..' as never)).toThrow(/Неизвестный тип/)
  })

  it('rejects traversal, separators and absolute names', () => {
    for (const name of ['..\\evil.exe', 'a/b.exe', 'C:\\evil.exe', '', 'x:y']) {
      expect(() => stagingPath('updates', name)).toThrow(/Недопустимое имя/)
    }
  })
})

describe('stagingAclArgs', () => {
  it('removes inheritance and grants SYSTEM + Administrators by SID only', () => {
    const args = stagingAclArgs('C:\\ProgramData\\SkipNet\\updates')
    expect(args).toContain('/inheritance:r')
    expect(args).toContain('/grant:r')
    expect(args).toContain('*S-1-5-18:(OI)(CI)F')
    expect(args).toContain('*S-1-5-32-544:(OI)(CI)F')
    // Locale-independent: no localized group names such as "Администраторы".
    expect(args.join(' ')).not.toMatch(/Administrators|Администратор/i)
  })
})

describe('secureStagingDir (dev override)', () => {
  it('creates a private directory and returns it', () => {
    const dir = secureStagingDir('updates')

    expect(dir).toBe(path.join(root, 'updates'))
    expect(statSync(dir).isDirectory()).toBe(true)
  })

  it('is idempotent and keeps existing staged files', () => {
    const first = secureStagingDir('hosts')
    const file = path.join(first, 'payload.txt')
    writeFileSync(file, 'payload', { mode: 0o700 })

    expect(secureStagingDir('hosts')).toBe(first)
    expect(readFileSync(file, 'utf8')).toBe('payload')
  })
})
