/**
 * Upstream Zapret list updates.
 *
 * Mirrors the "Update IPSet List" / fresh lists workflow shipped in
 * Flowseal's `service.bat`, but runs inside SkipNet:
 *
 *  - host lists (`lists/list-general.txt`, `list-exclude.txt`,
 *    `list-google.txt`, `ipset-exclude.txt`) come from the upstream
 *    repository;
 *  - the IP list (`.service/ipset-service.txt`) is written to
 *    `lists/ipset-all.txt`.
 *
 * User-maintained `*-user.txt` files are never touched. Every overwritten
 * file keeps a one-time `.backup` copy so "restore from backup" in the UI
 * can roll the update back.
 */

import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  statSync,
  writeFileSync
} from 'node:fs'
import path from 'node:path'
import { zapretBundleDir } from '../utils/dirs'
import { fetchGithub } from '../utils/github'
import { isValidCidrEntry, isValidListEntry, normalizeListContent } from './zapret-list-lines'

const DEFAULT_UPSTREAM_BASE =
  'https://raw.githubusercontent.com/Flowseal/zapret-discord-youtube/refs/heads/main'

// Kept overridable so a local mock server can exercise the full download
// → validate → write path without hitting GitHub.
function upstreamBase(): string {
  const override = process.env.SKIPNET_ZAPRET_LISTS_BASE?.trim()
  return (override || DEFAULT_UPSTREAM_BASE).replace(/\/+$/, '')
}

const REQUEST_HEADERS: Record<string, string> = {
  'User-Agent': 'SkipNet-ZapretLists',
  Accept: 'text/plain, */*',
  'Cache-Control': 'no-cache'
}

const MAX_LIST_BYTES = 20 * 1024 * 1024

export type ZapretListsScope = 'hosts' | 'ip' | 'all'

interface ListSpec {
  id: string
  /** Human-readable name used in toasts/errors. */
  name: string
  /** Path relative to the Zapret `lists/` directory. */
  file: string
  /** Path relative to the upstream repository root. */
  remotePath: string
  /** Reject suspiciously short downloads (HTML error pages, truncation). */
  minEntries: number
  validate: (line: string) => boolean
}

const HOST_SPECS: ListSpec[] = [
  {
    id: 'general',
    name: 'list-general.txt',
    file: 'list-general.txt',
    remotePath: 'lists/list-general.txt',
    minEntries: 5,
    validate: isValidListEntry
  },
  {
    id: 'exclude',
    name: 'list-exclude.txt',
    file: 'list-exclude.txt',
    remotePath: 'lists/list-exclude.txt',
    minEntries: 5,
    validate: isValidListEntry
  },
  {
    id: 'google',
    name: 'list-google.txt',
    file: 'list-google.txt',
    remotePath: 'lists/list-google.txt',
    minEntries: 5,
    validate: isValidListEntry
  },
  {
    id: 'ipsetExclude',
    name: 'ipset-exclude.txt',
    file: 'ipset-exclude.txt',
    remotePath: 'lists/ipset-exclude.txt',
    minEntries: 5,
    validate: isValidListEntry
  }
]

const IPSET_SPEC: ListSpec = {
  id: 'ipset',
  name: 'ipset-all.txt',
  file: 'ipset-all.txt',
  remotePath: '.service/ipset-service.txt',
  // The upstream IP list currently ships ~33k ranges; anything below a
  // thousand almost certainly means a proxy/error page was returned.
  minEntries: 1000,
  validate: isValidCidrEntry
}

const ALL_SPECS = [...HOST_SPECS, IPSET_SPEC]

export interface ZapretListFileStatus {
  id: string
  name: string
  file: string
  path: string
  exists: boolean
  entries: number
  bytes: number
  updatedAt?: string
}

export interface ZapretListsStatus {
  dir: string
  available: boolean
  source: string
  files: ZapretListFileStatus[]
}

export interface ZapretListsUpdateResult {
  updated: Array<{
    id: string
    name: string
    file: string
    entries: number
    bytes: number
  }>
  totalEntries: number
  status: ZapretListsStatus
}

function listsDir(): string {
  return path.join(zapretBundleDir(), 'lists')
}

function ensureBundle(): string {
  const dir = listsDir()
  if (!existsSync(path.join(zapretBundleDir(), 'general.bat'))) {
    throw new Error('Zapret-бандл не найден. Установите или обновите Zapret и повторите попытку.')
  }
  return dir
}

function safeSize(file: string): number {
  try {
    return statSync(file).size
  } catch {
    return 0
  }
}

function readText(file: string): string {
  try {
    return readFileSync(file, 'utf-8')
  } catch {
    return ''
  }
}

function countEntries(raw: string, validate: (line: string) => boolean): number {
  let total = 0
  for (const line of raw.split(/\r?\n/)) {
    if (validate(line)) total++
  }
  return total
}

export function getZapretListsStatus(): ZapretListsStatus {
  const dir = listsDir()
  const available = existsSync(path.join(zapretBundleDir(), 'general.bat'))
  const files = ALL_SPECS.map<ZapretListFileStatus>((spec) => {
    const file = path.join(dir, spec.file)
    const exists = existsSync(file)
    const raw = exists ? readText(file) : ''
    let updatedAt: string | undefined
    try {
      updatedAt = statSync(file).mtime.toISOString()
    } catch {
      updatedAt = undefined
    }
    return {
      id: spec.id,
      name: spec.name,
      file: spec.file,
      path: file,
      exists,
      entries: countEntries(raw, spec.validate),
      bytes: exists ? safeSize(file) : 0,
      updatedAt
    }
  })
  return { dir, available, source: upstreamBase(), files }
}

function backupPath(file: string): string {
  return `${file}.backup`
}

/**
 * Create a rollback copy the first time we touch a file. Existing backups
 * are left alone so the user always keeps the option to return to the
 * original bundled list.
 */
function ensureBackup(file: string): void {
  if (!existsSync(file)) return
  const backup = backupPath(file)
  if (existsSync(backup) && safeSize(backup) > 0) return
  try {
    copyFileSync(file, backup)
  } catch {
    /* best-effort — an update should not fail because of the backup */
  }
}

function writeAtomic(file: string, content: string): void {
  mkdirSync(path.dirname(file), { recursive: true })
  const tmp = `${file}.tmp-${process.pid}-${Date.now()}`
  writeFileSync(tmp, content, 'utf8')
  try {
    renameSync(tmp, file)
  } catch {
    // Windows occasionally refuses rename-over-existing when the file is
    // briefly held open (AV scan, winws reading the list). Fall back to a
    // direct write; if that fails too the error propagates to the UI.
    writeFileSync(file, content, 'utf8')
  }
}

async function downloadList(
  spec: ListSpec
): Promise<{ spec: ListSpec; content: string; entries: number }> {
  const url = `${upstreamBase()}/${spec.remotePath}`
  let res: Response
  try {
    res = await fetchGithub(url, { headers: REQUEST_HEADERS, timeoutMs: 45_000 })
  } catch (e) {
    throw new Error(
      `${spec.name}: ${e instanceof Error ? e.message : String(e)}`
    )
  }
  if (!res.ok) {
    throw new Error(`${spec.name}: HTTP ${res.status}`)
  }
  const raw = await res.text()
  if (!raw.trim()) {
    throw new Error(`${spec.name}: получен пустой файл`)
  }
  if (raw.length > MAX_LIST_BYTES) {
    throw new Error(`${spec.name}: файл слишком большой (${raw.length} байт)`)
  }
  const { content, entries } = normalizeListContent(raw, spec.validate)
  if (entries < spec.minEntries) {
    throw new Error(
      `${spec.name}: список выглядит неполным (${entries} записей, ожидалось не меньше ${spec.minEntries})`
    )
  }
  return { spec, content, entries }
}

/**
 * Download and install upstream Zapret lists. All requested files are
 * fetched and validated before anything is written, so a failed download
 * never leaves the bundle with a half-updated list set.
 */
export async function updateZapretLists(
  scope: ZapretListsScope = 'all'
): Promise<ZapretListsUpdateResult> {
  const dir = ensureBundle()
  const specs =
    scope === 'ip' ? [IPSET_SPEC] : scope === 'hosts' ? HOST_SPECS : ALL_SPECS

  const results = await Promise.allSettled(specs.map((spec) => downloadList(spec)))
  const failures = results
    .filter((r): r is PromiseRejectedResult => r.status === 'rejected')
    .map((r) => (r.reason instanceof Error ? r.reason.message : String(r.reason)))

  if (failures.length > 0) {
    throw new Error(
      `Не удалось обновить списки Zapret:\n${failures.map((f) => `• ${f}`).join('\n')}`
    )
  }

  const updated: ZapretListsUpdateResult['updated'] = []
  let totalEntries = 0

  for (const result of results) {
    if (result.status !== 'fulfilled') continue
    const { spec, content, entries } = result.value
    const target = path.join(dir, spec.file)
    ensureBackup(target)
    writeAtomic(target, content)
    updated.push({
      id: spec.id,
      name: spec.name,
      file: target,
      entries,
      bytes: Buffer.byteLength(content, 'utf8')
    })
    totalEntries += entries
  }

  return { updated, totalEntries, status: getZapretListsStatus() }
}
