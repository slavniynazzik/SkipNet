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
  replace?: boolean
}

// list-general.txt is consumed by Zapret as a hostlist (SNI / Host
// header matching). Domains are the primary entry; IPs/CIDRs are
// accepted too вЂ” some Zapret strategies cross-reference both. The
// entry grammar lives in `zapret-list-lines.ts` so the upstream updater
// validates exactly the same way.

export const CURATED_IP_SETS: CuratedIpSet[] = [
  {
    id: 'discord',
    name: 'Discord',
    description: 'РћСЃРЅРѕРІРЅС‹Рµ РґРѕРјРµРЅС‹ Discord, РёС… CDN Рё РіРѕР»РѕСЃРѕРІС‹С… СЃРµСЂРІРёСЃРѕРІ.',
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
    description: 'Р”РѕРјРµРЅС‹ Telegram Рё РІСЃРїРѕРјРѕРіР°С‚РµР»СЊРЅС‹С… СЃРµСЂРІРёСЃРѕРІ.',
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
    description: 'Р”РѕРјРµРЅС‹ YouTube Рё СЃРјРµР¶РЅС‹С… СЃРµСЂРІРёСЃРѕРІ Google.',
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
    description: 'РљР»СЋС‡РµРІС‹Рµ РґРѕРјРµРЅС‹ Cloudflare (DNS, Workers, ECH, R2).',
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
    description: 'Р”РѕРјРµРЅС‹ Twitch Рё РёС… CDN.',
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
    description: 'Р”РѕРјРµРЅС‹ Spotify Рё СЃРјРµР¶РЅС‹С… CDN.',
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
  // No upstream backup is shipped for list-general.txt вЂ” we mint one
  // ourselves on first edit (see ensureBackup) so В«restore from backupВ»
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
    throw new Error(`zapret-bundle РѕС‚СЃСѓС‚СЃС‚РІСѓРµС‚: РЅРµС‚ ${dir}. РЈСЃС‚Р°РЅРѕРІРёС‚Рµ/РѕР±РЅРѕРІРёС‚Рµ Zapret.`)
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
 *  - replace=true в†’ wipe the file first
 *  - then merge in entries from selected curated sets + custom user lines
 *
 * Accepts hostnames, IPv4/IPv6 addresses, and CIDR ranges. Invalid lines
 * are silently dropped; duplicates collapsed. The original Flowseal
 * hostlist is backed up to list-general.txt.backup on first edit so
 * the user can restore it.
 */
export function applyIpListPatch(patch: IpListPatch): IpListSnapshot {
  ensureDirOrThrow()
  ensureBackup()
  const file = listFile()

  const existing = patch.replace ? [] : readLines(file).filter(isValidListEntry)

  const fromSets: string[] = []
  if (patch.setIds && patch.setIds.length) {
    const byId = new Map(CURATED_IP_SETS.map((s) => [s.id, s]))
    for (const id of patch.setIds) {
      const s = byId.get(id)
      if (s) fromSets.push(...s.cidrs)
    }
  }

  const fromCustom = (patch.customCidrs ?? [])
    .flatMap((s) => s.split(/[\s,;]+/))
    .map((s) => s.trim())
    .filter(isValidListEntry)

  const merged = dedup([...existing, ...fromSets, ...fromCustom])
  writeAtomic(file, merged.join('\r\n') + (merged.length ? '\r\n' : ''))

  // Persist the user-controlled part to the `-user` list that upstream list
  // updates never touch, so a later "Списки хостов" refresh cannot delete
  // curated/custom entries. `replace` resets it to just this patch.
  const userFile = userListFile()
  const existingUser = patch.replace ? [] : readLines(userFile).filter(isValidListEntry)
  // One-time migration: entries added by older SkipNet builds were written
  // straight into list-general.txt. Anything not present in the pristine
  // backup is user-added and must survive the next upstream refresh.
  const legacyUserEntries = patch.replace
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
    throw new Error('Backup-С„Р°Р№Р» list-general.txt.backup РµС‰С‘ РЅРµ СЃРѕР·РґР°РЅ (РІС‹ РЅРё СЂР°Р·Сѓ РЅРµ РїСЂР°РІРёР»Рё СЃРїРёСЃРѕРє).')
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
