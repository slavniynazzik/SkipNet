/**
 * "Update Hosts File" from Flowseal's `service.bat`.
 *
 * The upstream hosts snippet is compared against the Windows hosts file using
 * its first and last line, exactly like the batch script. SkipNet can also
 * apply the snippet automatically (`applyHostsUpdate`): the managed entries
 * are written as one marked block, so repeated updates replace it instead of
 * piling duplicates on top. Writing `%SystemRoot%\System32\drivers\etc\hosts`
 * needs administrator rights; the app normally has them and otherwise retries
 * through a UAC prompt.
 */

import { copyFileSync, existsSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawn } from 'node:child_process'
import { shell } from 'electron'
import { fetchGithub } from '../utils/github'
import { psQuote, runPowerShellElevated } from '../utils/elevated'

const DEFAULT_UPSTREAM_BASE =
  'https://raw.githubusercontent.com/Flowseal/zapret-discord-youtube/refs/heads/main'

const BLOCK_START = '# --- SkipNet (Zapret) hosts BEGIN ---'
const BLOCK_END = '# --- SkipNet (Zapret) hosts END ---'

function upstreamBase(): string {
  const override = process.env.SKIPNET_ZAPRET_LISTS_BASE?.trim()
  return (override || DEFAULT_UPSTREAM_BASE).replace(/\/+$/, '')
}

export interface HostsCheckResult {
  hostsPath: string
  hostsExists: boolean
  /** Downloaded snippet contains both YouTube host entries. */
  upToDate: boolean
  needsUpdate: boolean
  firstLine: string
  lastLine: string
  entries: number
  /** Temp copy of the upstream snippet (only filled by prepareHostsUpdate). */
  tempPath?: string
}

export interface HostsApplyResult {
  ok: boolean
  message: string
  hostsPath: string
  /** Number of managed entries written. */
  entries: number
  /** Backup of the previous hosts file, when one was created. */
  backupPath?: string
  /** True when the write required the elevated fallback. */
  elevated: boolean
}

export function windowsHostsPath(): string {
  const root = process.env.SystemRoot || process.env.windir || 'C:\\Windows'
  return path.join(root, 'System32', 'drivers', 'etc', 'hosts')
}

function readHosts(): string {
  try {
    return readFileSync(windowsHostsPath(), 'utf-8')
  } catch {
    return ''
  }
}

/** Read the hosts file byte-for-byte (latin1 round-trips arbitrary bytes). */
function readHostsRaw(): string {
  try {
    return readFileSync(windowsHostsPath()).toString('latin1')
  } catch {
    return ''
  }
}

async function downloadHosts(): Promise<string> {
  const url = `${upstreamBase()}/.service/hosts`
  const res = await fetchGithub(url, {
    headers: { 'User-Agent': 'SkipNet-ZapretHosts', Accept: 'text/plain, */*', 'Cache-Control': 'no-cache' },
    timeoutMs: 20_000
  })
  if (!res.ok) throw new Error(`hosts: HTTP ${res.status}`)
  const text = await res.text()
  if (!text.trim()) throw new Error('hosts: получен пустой файл')
  return text
}

function compare(remote: string): HostsCheckResult {
  const hostsPath = windowsHostsPath()
  const hosts = readHosts()
  const lines = remote.split(/\r?\n/).map((l) => l.trimEnd())
  const nonEmpty = lines.filter((l) => l.trim() !== '')
  const firstLine = nonEmpty[0] ?? ''
  const lastLine = nonEmpty[nonEmpty.length - 1] ?? ''
  const upToDate =
    !!hosts &&
    !!firstLine &&
    !!lastLine &&
    hosts.includes(firstLine) &&
    hosts.includes(lastLine)
  return {
    hostsPath,
    hostsExists: existsSync(hostsPath),
    upToDate,
    needsUpdate: !upToDate,
    firstLine,
    lastLine,
    entries: nonEmpty.length
  }
}

/** Download the upstream snippet and report whether the hosts file matches. */
export async function checkZapretHosts(): Promise<HostsCheckResult> {
  return compare(await downloadHosts())
}

/**
 * Download the snippet to a temp file and open it in Notepad, selecting the
 * real hosts file in Explorer — the same workflow `service.bat` uses.
 */
export async function prepareHostsUpdate(): Promise<HostsCheckResult> {
  const remote = await downloadHosts()
  const result = compare(remote)
  const tempPath = path.join(os.tmpdir(), `skipnet-zapret-hosts-${Date.now()}.txt`)
  writeFileSync(tempPath, remote.endsWith('\n') ? remote : `${remote}\n`, 'utf-8')
  result.tempPath = tempPath
  try {
    const p = spawn('notepad.exe', [tempPath], { detached: true, stdio: 'ignore' })
    p.unref()
  } catch {
    try {
      await shell.openPath(tempPath)
    } catch {
      /* best-effort — the temp path is still returned to the UI */
    }
  }
  try {
    shell.showItemInFolder(result.hostsPath)
  } catch {
    /* best-effort */
  }
  return result
}

/**
 * Mix the upstream entries into the current hosts file:
 *  - drop a previously managed SkipNet block, if any;
 *  - drop plain lines whose host name is managed by the snippet (avoids
 *    duplicate/conflicting entries on repeated updates);
 *  - append one fresh marked block at the end.
 *
 * Everything is handled as latin1 so the original byte layout of unrelated
 * lines (comments in a legacy code page, CRLF endings) is preserved.
 */
function mergeHosts(current: string, remote: string): { content: string; entries: number } {
  const entries = remote
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line !== '' && !line.startsWith('#'))

  const managedHosts = new Set<string>()
  for (const entry of entries) {
    const host = entry.split(/\s+/)[1]
    if (host) managedHosts.add(host.toLowerCase())
  }

  const kept: string[] = []
  let inBlock = false
  for (const line of current.split(/\r?\n/)) {
    const trimmed = line.trim()
    if (trimmed === BLOCK_START) {
      inBlock = true
      continue
    }
    if (inBlock) {
      if (trimmed === BLOCK_END) inBlock = false
      continue
    }
    if (trimmed !== '' && !trimmed.startsWith('#')) {
      const host = trimmed.split(/\s+/)[1]
      if (host && managedHosts.has(host.toLowerCase())) continue
    }
    kept.push(line)
  }

  while (kept.length > 0 && kept[kept.length - 1].trim() === '') kept.pop()

  const block = [BLOCK_START, ...entries, BLOCK_END]
  const content = `${[...kept, '', ...block].join('\r\n')}\r\n`
  return { content, entries: entries.length }
}

/**
 * Write the merged hosts file. Direct write works because SkipNet is elevated;
 * if the process somehow lost elevation, retry through UAC.
 */
function writeHostsFile(content: string): { ok: boolean; elevated: boolean; error?: string } {
  const target = windowsHostsPath()
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
        error: message || (directError instanceof Error ? directError.message : String(directError))
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

/**
 * Download the upstream snippet and write it into the system hosts file,
 * keeping a backup of the previous file next to it.
 */
export async function applyHostsUpdate(): Promise<HostsApplyResult> {
  const remote = await downloadHosts()
  const hostsPath = windowsHostsPath()
  const before = readHostsRaw()
  const { content, entries } = mergeHosts(before, remote)

  const backupPath = path.join(path.dirname(hostsPath), 'hosts.skipnet-backup')
  if (existsSync(hostsPath)) {
    try {
      copyFileSync(hostsPath, backupPath)
    } catch {
      /* a missing backup must not block the actual update */
    }
  }

  const written = writeHostsFile(content)
  if (!written.ok) {
    throw new Error(
      `Не удалось записать файл hosts: ${written.error ?? 'неизвестная ошибка'}. ` +
        'Запустите SkipNet от администратора.'
    )
  }

  const check = compare(remote)
  if (!check.upToDate) {
    throw new Error(
      'Файл hosts записан, но проверка не подтвердила обновление. ' +
        'Возможно, запись заблокирована антивирусом.'
    )
  }

  return {
    ok: true,
    message: written.elevated
      ? 'Файл hosts обновлён (потребовались права администратора).'
      : 'Файл hosts обновлён.',
    hostsPath,
    entries,
    backupPath: existsSync(backupPath) ? backupPath : undefined,
    elevated: written.elevated
  }
}

/** True when the hosts file contains YouTube entries (a common cause of issues). */
export function hostsHasYoutubeEntries(): boolean {
  const hosts = readHosts()
  if (!hosts) return false
  return hosts
    .split(/\r?\n/)
    .some((line) => {
      const value = line.trim()
      if (!value || value.startsWith('#')) return false
      return /youtube\.com|youtu\.be/i.test(value)
    })
}
