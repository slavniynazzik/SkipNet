/**
 * Game filter + IPSet filter settings.
 *
 * Mirrors the "Game Filter" / "IPSet Filter" switches from Flowseal's
 * `service.bat`, but keeps the state in SkipNet's config and writes the
 * files Zapret's `general.bat` actually reads:
 *
 *  - `utils/game_filter.enabled` — `mode=`, `tcp=`, `udp=` lines;
 *  - `lists/ipset-all.txt` — see `zapret-lists.ts` for the IPSet modes.
 *
 * The game filter file is rewritten before every winws.exe launch so the
 * bundle always matches what the user picked in the UI, even after a
 * bundle reinstall reset the runtime folder.
 */

import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { zapretBundleDir } from '../utils/dirs'
import { getAppConfig, patchAppConfig } from '../config'

export type GameFilterMode = 'disabled' | 'all' | 'tcp' | 'udp'

export const GAME_FILTER_MODES: GameFilterMode[] = ['disabled', 'all', 'tcp', 'udp']

export const DEFAULT_GAME_FILTER_RANGE = '1024-65535'

export interface GameFilterSettings {
  mode: GameFilterMode
  tcpRange: string
  udpRange: string
  enabled: boolean
}

export interface SetGameFilterInput {
  mode?: GameFilterMode
  tcpRange?: string
  udpRange?: string
}

function gameFilterFile(): string {
  return path.join(zapretBundleDir(), 'utils', 'game_filter.enabled')
}

/**
 * Normalise a port list/ranges string the same way `service.bat` does:
 * comma-separated single ports or `start-end` ranges, 1..65535, start ≤ end.
 * Returns the cleaned value or `null` when anything is invalid.
 */
export function validateGameFilterRange(input: string): string | null {
  const raw = (input ?? '').replace(/\s+/g, '')
  if (!raw) return null
  const out: string[] = []
  for (const item of raw.split(',')) {
    const m = /^(\d{1,5})(?:-(\d{1,5}))?$/.exec(item)
    if (!m) return null
    const start = Number(m[1])
    const end = m[2] === undefined ? start : Number(m[2])
    if (start < 1 || end < 1 || start > 65535 || end > 65535) return null
    if (start > end) return null
    out.push(m[2] === undefined ? String(start) : `${start}-${end}`)
  }
  return out.length ? out.join(',') : null
}

function normalizeMode(mode: unknown, legacyEnabled?: boolean): GameFilterMode {
  if (mode === 'all' || mode === 'tcp' || mode === 'udp' || mode === 'disabled') return mode
  return legacyEnabled ? 'all' : 'disabled'
}

/** Read the effective settings from the persisted config. */
export function getGameFilterSettings(
  zapret: ZapretConfig | undefined = undefined
): GameFilterSettings {
  const z = zapret
  const mode = normalizeMode(z?.gameFilterMode, z?.gameFilter)
  const tcpRange =
    validateGameFilterRange(z?.gameFilterTcpRange ?? '') ?? DEFAULT_GAME_FILTER_RANGE
  const udpRange =
    validateGameFilterRange(z?.gameFilterUdpRange ?? '') ?? DEFAULT_GAME_FILTER_RANGE
  return { mode, tcpRange, udpRange, enabled: mode !== 'disabled' }
}

/** True when an unpacked Zapret bundle is present in the runtime folder. */
export function hasZapretBundle(): boolean {
  return existsSync(path.join(zapretBundleDir(), 'general.bat'))
}

/**
 * Write (or remove) `utils/game_filter.enabled` for the given settings.
 * `general.bat` calls `service.bat load_game_filter` at startup, so this
 * must run before winws.exe is spawned.
 */
export function applyGameFilterToBundle(settings: GameFilterSettings): void {
  if (!hasZapretBundle()) return
  const file = gameFilterFile()
  if (settings.mode === 'disabled') {
    try {
      rmSync(file, { force: true })
    } catch {
      /* best-effort — a stale file only re-enables the old rules */
    }
    return
  }
  mkdirSync(path.dirname(file), { recursive: true })
  const content =
    `mode=${settings.mode}\r\n` +
    `tcp=${settings.tcpRange}\r\n` +
    `udp=${settings.udpRange}\r\n`
  // ASCII-only payload: the bundled .bat files are read with the OEM code
  // page, so never let non-ASCII text leak into this file.
  writeFileSync(file, content, 'ascii')
}

export interface SetGameFilterResult extends GameFilterSettings {
  /** False when no bundle is installed yet; the config is still saved. */
  applied: boolean
}

/** Validate, persist and apply a game filter change. */
export async function setGameFilter(input: SetGameFilterInput): Promise<SetGameFilterResult> {
  const cfg = await getAppConfig()
  const current = getGameFilterSettings(cfg.zapret)
  const mode = normalizeMode(input.mode ?? current.mode)
  const tcpRange = validateGameFilterRange(input.tcpRange ?? current.tcpRange)
  const udpRange = validateGameFilterRange(input.udpRange ?? current.udpRange)
  if (!tcpRange) {
    throw new Error('Некорректный диапазон TCP-портов. Пример: 1024-65535 или 1024-1934,1936-65535')
  }
  if (!udpRange) {
    throw new Error('Некорректный диапазон UDP-портов. Пример: 1024-65535 или 1024-1934,1936-65535')
  }
  const next: GameFilterSettings = {
    mode,
    tcpRange,
    udpRange,
    enabled: mode !== 'disabled'
  }

  await patchAppConfig({
    zapret: {
      gameFilter: next.enabled,
      gameFilterMode: next.mode,
      gameFilterTcpRange: next.tcpRange,
      gameFilterUdpRange: next.udpRange
    }
  })

  const applied = hasZapretBundle()
  if (applied) applyGameFilterToBundle(next)
  return { ...next, applied }
}
