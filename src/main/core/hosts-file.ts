/**
 * Low-level access to the Windows hosts file.
 *
 * Shared by the hosts editor, diagnostics and backups. The file is handled as
 * latin1 so arbitrary legacy bytes survive a read → edit → write round-trip:
 * hostnames and IPs are ASCII, and unrelated comment bytes are never
 * re-encoded.
 */

import { accessSync, constants, existsSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { psQuote, runPowerShellElevated } from '../utils/elevated'

const BLOCK_START = '# --- SkipNet hosts editor BEGIN ---'
const BLOCK_END = '# --- SkipNet hosts editor END ---'

export function windowsHostsPath(): string {
  const root = process.env.SystemRoot || process.env.windir || 'C:\\Windows'
  return path.join(root, 'System32', 'drivers', 'etc', 'hosts')
}

/** Read the hosts file byte-for-byte (latin1 round-trips arbitrary bytes). */
export function readHostsRaw(): string {
  try {
    return readFileSync(windowsHostsPath()).toString('latin1')
  } catch {
    return ''
  }
}

/** Read the hosts file as UTF-8 for display/diagnostics. */
export function readHostsText(): string {
  try {
    return readFileSync(windowsHostsPath(), 'utf-8')
  } catch {
    return ''
  }
}

export function hostsFileExists(): boolean {
  return existsSync(windowsHostsPath())
}

/** Best-effort write-access probe (the real check is the write attempt). */
export function hostsFileWritable(): boolean {
  try {
    accessSync(windowsHostsPath(), constants.W_OK)
    return true
  } catch {
    return false
  }
}

export interface HostsWriteResult {
  ok: boolean
  elevated: boolean
  error?: string
}

/**
 * Write the hosts file. Direct write works when SkipNet has administrator
 * rights; otherwise retry through a UAC-elevated PowerShell copy.
 */
export function writeHostsContent(content: string): HostsWriteResult {
  return writeHostsContentTo(windowsHostsPath(), content)
}

/** Same writer with an explicit target, used by tests and future backups. */
export function writeHostsContentTo(target: string, content: string): HostsWriteResult {
  try {
    writeFileSync(target, Buffer.from(content, 'latin1'))
    return { ok: true, elevated: false }
  } catch (directError) {
    const tempPath = path.join(os.tmpdir(), `skipnet-hosts-new-${Date.now()}.txt`)
    try {
      writeFileSync(tempPath, Buffer.from(content, 'latin1'))
      const script =
        'try {\r\n' +
        `  Copy-Item -LiteralPath ${psQuote(tempPath)} -Destination ${psQuote(target)} -Force -ErrorAction Stop\r\n` +
        '} catch {\r\n' +
        '  Write-Error $_\r\n  exit 1\r\n' +
        '}\r\n'
      const elevated = runPowerShellElevated(script, 60_000)
      if (elevated.ok) return { ok: true, elevated: true }
      return {
        ok: false,
        elevated: true,
        error: elevated.stderr.trim() || 'UAC был отменён или запись запрещена'
      }
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e)
      return {
        ok: false,
        elevated: false,
        error:
          message ||
          (directError instanceof Error ? directError.message : String(directError))
      }
    } finally {
      try {
        if (existsSync(tempPath)) unlinkSync(tempPath)
      } catch {
        /* temp file — Windows will clean it eventually */
      }
    }
  }
}

export function flushDns(): { ok: boolean; message: string } {
  try {
    const result = spawnSync('ipconfig.exe', ['/flushdns'], {
      windowsHide: true,
      timeout: 10_000,
      encoding: 'utf8'
    })
    if (result.status === 0) {
      return { ok: true, message: 'DNS-кэш очищен.' }
    }
    return {
      ok: false,
      message: `ipconfig /flushdns завершился с кодом ${result.status ?? '?'}.`
    }
  } catch (e) {
    return {
      ok: false,
      message: e instanceof Error ? e.message : String(e)
    }
  }
}

export const HOSTS_BLOCK_START = BLOCK_START
export const HOSTS_BLOCK_END = BLOCK_END
