import { readFileSync } from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  HOSTS_ADOBE_BLOCK_END,
  HOSTS_ADOBE_BLOCK_START,
  HOSTS_EDITOR_BLOCK_END,
  HOSTS_EDITOR_BLOCK_START
} from '../src/shared/hosts-markers'
import { stripSkipNetBlocksForUninstall } from '@main/core/hosts-render'

const SCRIPT_PATH = path.join(process.cwd(), 'resources', 'uninstall-hosts-cleanup.ps1')

describe('uninstall-hosts-cleanup.ps1', () => {
  const script = readFileSync(SCRIPT_PATH, 'utf8')

  it('contains the shared marker constants verbatim', () => {
    // The script cannot import TypeScript, so the strings are duplicated. This
    // test is the guard against drift: a marker rename on either side would
    // leave the uninstaller unable to remove a real block.
    expect(script).toContain(HOSTS_EDITOR_BLOCK_START)
    expect(script).toContain(HOSTS_EDITOR_BLOCK_END)
    expect(script).toContain(HOSTS_ADOBE_BLOCK_START)
    expect(script).toContain(HOSTS_ADOBE_BLOCK_END)
  })

  it('backs up, writes through a temp file and moves it into place', () => {
    expect(script).toContain('hosts.skipnet-backup-')
    expect(script).toContain('[IO.File]::Open')
    expect(script).toContain('Flush($true)')
    expect(script).toContain('Move-Item -LiteralPath $tmp -Destination $hostsPath -Force')
    expect(script).toContain('[Text.Encoding]::GetEncoding(28591)')
  })
})

describe('stripSkipNetBlocksForUninstall (reference algorithm)', () => {
  it('removes the managed block, keeps unrelated entries and CRLF', () => {
    const original = [
      '# Copyright (c) Microsoft',
      '127.0.0.1 localhost',
      '',
      HOSTS_EDITOR_BLOCK_START,
      '# >>> SkipNet service: youtube',
      '1.2.3.4 youtube.com',
      '# <<< SkipNet service: youtube',
      HOSTS_EDITOR_BLOCK_END,
      '',
      '10.0.0.1 nas.local',
      ''
    ].join('\r\n')

    const result = stripSkipNetBlocksForUninstall(original)
    expect(result.changed).toBe(true)
    expect(result.content).not.toContain(HOSTS_EDITOR_BLOCK_START)
    expect(result.content).not.toContain(HOSTS_EDITOR_BLOCK_END)
    expect(result.content).toContain('# Copyright (c) Microsoft')
    expect(result.content).toContain('127.0.0.1 localhost')
    expect(result.content).toContain('10.0.0.1 nas.local')
    // No line ending was converted to a bare LF.
    expect(result.content.replace(/\r\n/g, '')).not.toContain('\n')
  })

  it('removes the Adobe block at EOF without a trailing newline', () => {
    const original = [
      '127.0.0.1 localhost',
      HOSTS_ADOBE_BLOCK_START,
      '127.0.0.1 adobe.example',
      HOSTS_ADOBE_BLOCK_END
    ].join('\r\n')

    const result = stripSkipNetBlocksForUninstall(original)
    expect(result.changed).toBe(true)
    expect(result.content).not.toContain(HOSTS_ADOBE_BLOCK_START)
    expect(result.content).toBe('127.0.0.1 localhost\r\n')
  })

  it('leaves the file untouched when a BEGIN marker is unterminated', () => {
    const original = [
      '127.0.0.1 localhost',
      HOSTS_EDITOR_BLOCK_START,
      '1.2.3.4 youtube.com'
    ].join('\r\n')

    expect(stripSkipNetBlocksForUninstall(original)).toEqual({
      content: original,
      changed: false
    })
  })

  it('reports no change when no SkipNet block is present', () => {
    const original = '127.0.0.1 localhost\r\n::1 localhost\r\n'
    expect(stripSkipNetBlocksForUninstall(original)).toEqual({
      content: original,
      changed: false
    })
  })
})
