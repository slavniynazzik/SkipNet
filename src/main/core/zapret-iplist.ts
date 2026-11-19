import { existsSync, readFileSync, writeFileSync, copyFileSync, statSync } from 'node:fs'
import path from 'node:path'
import { zapretBundleDir } from '../utils/dirs'
import { isValidListEntry } from './zapret-list-lines'

export interface CuratedIpSet {
  id: string
  name: string
  description: string
  cidrs: string[]
}

export interface IpListSnapshot {
  total: number
  preview: string[]
  hasBackup: boolean
  filePath: string
}

export interface IpListPatch {
  setIds?: string[]
  customCidrs?: string[]
  /** Accepted as an alias for host lines; validated exactly like `customCidrs`. */
  customHosts?: string[]
  replace?: boolean
}

/**
 * Renderer input is untrusted. A string where an array is expected used to
 * fail deep inside `.flatMap` with an opaque `TypeError`; reject it up front
 * with a message the UI can show.
 */
function readStringArray(value: unknown, field: string): string[] {
  if (value === undefined) return []
  if (!Array.isArray(value)) {
    throw new Error(`Некорректные данные списка: «${field}» должен быть массивом строк.`)
  }
  return value.map((item, index) => {
    if (typeof item !== 'string') {
      throw new Error(
        `Некорректные данные списка: «${field}[${index}]» должен быть строкой.`
      )
    }
    return item
  })
}

// list-general.txt is consumed by Zapret as a hostlist (SNI / Host
// header matching). Domains are the primary entry; IPs/CIDRs are
// accepted too — some Zapret strategies cross-reference both. The
// entry grammar lives in `zapret-list-lines.ts` so the upstream updater
// validates exactly the same way.

export const CURATED_IP_SETS: CuratedIpSet[] = [
  {
    id: 'discord',
    name: 'Discord',
    description: 'Основные домены Discord, их CDN и голосовых сервисов.',
    cidrs: [
      'discord.com',
      'discordapp.com',
      'discordapp.net',
      'discord.gg',
      'discord.gift',
      'discord.media',
      'discord.new',
      'discordcdn.com',
      'dis.gd',
      'discordstatus.com'
    ]
  },
  {
    id: 'telegram',
    name: 'Telegram',
    description: 'Домены Telegram и вспомогательных сервисов.',
    cidrs: [
      'telegram.org',
      'telegram.me',
      't.me',
      'telesco.pe',
      'web.telegram.org',
      'core.telegram.org',
      'cdn-telegram.org',
      'tdesktop.com',
      'telegram-cdn.org'
    ]
  },
  {
    id: 'youtube',
    name: 'YouTube / Google',
    description: 'Домены YouTube и смежных сервисов Google.',
    cidrs: [
      'youtube.com',
      'youtu.be',
      'youtubekids.com',
      'youtube-nocookie.com',
      'yt.be',
      'ytimg.com',
      'ggpht.com',
      'googlevideo.com',
      'youtubei.googleapis.com',
      'i.ytimg.com',
      's.ytimg.com',
      'm.youtube.com'
    ]
  },
  {
    id: 'cloudflare',
    name: 'Cloudflare',
    description: 'Ключевые домены Cloudflare (DNS, Workers, ECH, R2).',
    cidrs: [
      'cloudflare.com',
      'cloudflare-dns.com',
      'cloudflareinsights.com',
      'cloudflarestream.com',
      'cloudflareaccess.com',
      'cloudflare-ech.com',
      'workers.dev',
      'pages.dev',
      'r2.dev',
      'one.one.one.one'
    ]
  },
  {
    id: 'twitch',
    name: 'Twitch',
    description: 'Домены Twitch и их CDN.',
    cidrs: [
      'twitch.tv',
      'ttvnw.net',
      'jtvnw.net',
      'twitchcdn.net',
      'twitchsvc.net',
      'live-video.net',
      'helix.twitch.tv'
    ]
  },
  {
    id: 'spotify',
    name: 'Spotify',
    description: 'Домены Spotify и смежных CDN.',
    cidrs: [
      'spotify.com',
      'spotifycdn.com',
      'scdn.co',
      'spoti.fi',
      'spotilocal.com',
      'pscdn.co',
      'audio-fa.scdn.co',
      'audio-ak.spotify.com'
    ]
  }
]

export function getCuratedIpSets(): CuratedIpSet[] {
  return CURATED_IP_SETS.map((s) => ({ ...s, cidrs: [...s.cidrs] }))
}

function listFile(): string {
  return path.join(zapretBundleDir(), 'lists', 'list-general.txt')
}

// Zapret's `general.bat` loads this file *in addition to* list-general.txt
// (`--hostlist="...list-general-user.txt"`). Entries the user adds through
// SkipNet must live here: "update lists from GitHub" replaces list-general.txt
// wholesale and would otherwise silently delete them.
function userListFile(): string {
  return path.join(zapretBundleDir(), 'lists', 'list-general-user.txt')
}

function backupFile(): string {
  // No upstream backup is shipped for list-general.txt — we mint one
  // ourselves on first edit (see ensureBackup) so «restore from backup»
  // can roll back to the original Flowseal hostlist.
  return path.join(zapretBundleDir(), 'lists', 'list-general.txt.backup')
}

function ensureBackup(): void {
  const src = listFile()
  const bak = backupFile()
  if (!existsSync(src)) return
  if (existsSync(bak) && safeSize(bak) > 0) return
  try { copyFileSync(src, bak) } catch { /* best-effort */ }
}

function readLines(file: string): string[] {
  if (!existsSync(file)) return []
  try {
    return readFileSync(file, 'utf-8').split(/\r?\n/)
  } catch {
    return []
  }
}

function dedup(list: string[]): string[] {
  const seen = new Set<string>()
  const out: string[] = []
  for (const raw of list) {
    const v = raw.trim()
    if (!v) continue
    if (seen.has(v)) continue
    seen.add(v)
    out.push(v)
  }
  return out
}

function ensureDirOrThrow(): void {
  const dir = path.dirname(listFile())
  if (!existsSync(dir)) {
    throw new Error(`zapret-bundle отсутствует: нет ${dir}. Установите/обновите Zapret.`)
  }
}

export function getIpListSnapshot(): IpListSnapshot {
  const file = listFile()
  // Report both files: general.bat applies list-general.txt and
  // list-general-user.txt together, so the UI count must include both.
  const lines = dedup(
    [...readLines(file), ...readLines(userListFile())].filter(isValidListEntry)
  )
  return {
    total: lines.length,
    preview: lines.slice(0, 25),
    hasBackup: existsSync(backupFile()) && safeSize(backupFile()) > 0,
    filePath: file
  }
}

function safeSize(file: string): number {
  try { return statSync(file).size } catch { return 0 }
}

/**
 * Apply a patch to list-general.txt:
 *  - replace=true → wipe the file first
 *  - then merge in entries from selected curated sets + custom user lines
 *
 * Accepts hostnames, IPv4/IPv6 addresses, and CIDR ranges. Invalid lines
 * are silently dropped; duplicates collapsed. The original Flowseal
 * hostlist is backed up to list-general.txt.backup on first edit so
 * the user can restore it.
 */
export function applyIpListPatch(patch: IpListPatch): IpListSnapshot {
  // Validate the IPC payload before touching the bundle or the filesystem.
  const setIds = readStringArray(patch.setIds, 'setIds')
  const customCidrs = readStringArray(patch.customCidrs, 'customCidrs')
  const customHosts = readStringArray(patch.customHosts, 'customHosts')
  if (patch.replace !== undefined && typeof patch.replace !== 'boolean') {
    throw new Error('Некорректные данные списка: «replace» должен быть true или false.')
  }
  const replace = patch.replace === true

  ensureDirOrThrow()
  ensureBackup()
  const file = listFile()

  const existing = replace ? [] : readLines(file).filter(isValidListEntry)

  const fromSets: string[] = []
  if (setIds.length) {
    const byId = new Map(CURATED_IP_SETS.map((s) => [s.id, s]))
    for (const id of setIds) {
      const s = byId.get(id)
      if (s) fromSets.push(...s.cidrs)
    }
  }

  const fromCustom = [...customCidrs, ...customHosts]
    .flatMap((s) => s.split(/[\s,;]+/))
    .map((s) => s.trim())
    .filter(isValidListEntry)

  const merged = dedup([...existing, ...fromSets, ...fromCustom])
  writeAtomic(file, merged.join('\r\n') + (merged.length ? '\r\n' : ''))

  // Persist the user-controlled part to the `-user` list that upstream list
  // updates never touch, so a later "Списки хостов" refresh cannot delete
  // curated/custom entries. `replace` resets it to just this patch.
  const userFile = userListFile()
  const existingUser = replace ? [] : readLines(userFile).filter(isValidListEntry)
  // One-time migration: entries added by older SkipNet builds were written
  // straight into list-general.txt. Anything not present in the pristine
  // backup is user-added and must survive the next upstream refresh.
  const legacyUserEntries = replace
    ? []
    : (() => {
        const original = new Set(readLines(backupFile()).filter(isValidListEntry))
        return existing.filter((entry) => !original.has(entry))
      })()
  const userMerged = dedup([...existingUser, ...legacyUserEntries, ...fromSets, ...fromCustom])
  writeAtomic(userFile, userMerged.join('\r\n') + (userMerged.length ? '\r\n' : ''))

  return getIpListSnapshot()
}

export function clearIpList(): IpListSnapshot {
  ensureDirOrThrow()
  ensureBackup()
  writeAtomic(listFile(), '')
  writeAtomic(userListFile(), '')
  return getIpListSnapshot()
}

/**
 * Restore list-general.txt from a backup. The first time the user edits
 * the file we copy the original Flowseal hostlist to .backup; restore
 * just copies it back.
 */
export function restoreIpListBackup(): IpListSnapshot {
  ensureDirOrThrow()
  const src = backupFile()
  if (!existsSync(src)) {
    throw new Error('Backup-файл list-general.txt.backup ещё не создан (вы ни разу не правили список).')
  }
  copyFileSync(src, listFile())
  return getIpListSnapshot()
}

function writeAtomic(file: string, content: string): void {
  // list-general.txt is loaded once when winws.exe starts; live mid-write
  // races aren't a real concern. A direct write is fine and avoids the
  // Windows rename-over-existing-file caveat entirely.
  writeFileSync(file, content, 'utf-8')
}
