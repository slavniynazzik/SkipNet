/**
 * "Update Hosts File" from Flowseal's `service.bat`.
 *
 * The upstream hosts snippet is compared against the Windows hosts file
 * using its first and last line, exactly like the batch script. Actually
 * writing `%SystemRoot%\System32\drivers\etc\hosts` needs administrator
 * rights, so — matching upstream behaviour — the app downloads the snippet
 * and opens it next to the real hosts file for a manual copy.
 */

import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawn } from 'node:child_process'
import { shell } from 'electron'
import { fetchGithub } from '../utils/github'

const DEFAULT_UPSTREAM_BASE =
  'https://raw.githubusercontent.com/Flowseal/zapret-discord-youtube/refs/heads/main'

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
