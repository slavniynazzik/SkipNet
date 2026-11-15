/**
 * "Replace active fakes" from Flowseal's `service.bat`.
 *
 * Zapret reads the active fake payloads from `bin/ACTIVE_DISCORD_UDP.bin`
 * and `bin/ACTIVE_GAME_UDP.bin`. The bundle ships many alternative `*.bin`
 * payloads; the user can swap which one is active without editing the
 * strategy .bat files.
 */

import { copyFileSync, existsSync, readdirSync, readFileSync, statSync, unlinkSync } from 'node:fs'
import { createHash } from 'node:crypto'
import path from 'node:path'
import { zapretBundleDir } from '../utils/dirs'

export type FakeKind = 'discord' | 'game'

export interface FakeFile {
  name: string
  path: string
  hash: string
  size: number
}

export interface ActiveFakeSlot {
  /** Current active payload file name, or null when its bytes match no bundle fake. */
  current: string | null
  activePath: string
  exists: boolean
}

export interface FakesStatus {
  available: boolean
  binDir: string
  fakes: FakeFile[]
  discord: ActiveFakeSlot
  game: ActiveFakeSlot
}

const ACTIVE_FILES: Record<FakeKind, string> = {
  discord: 'ACTIVE_DISCORD_UDP.bin',
  game: 'ACTIVE_GAME_UDP.bin'
}

function binDir(): string {
  return path.join(zapretBundleDir(), 'bin')
}

function hashFile(file: string): string {
  return createHash('sha256').update(readFileSync(file)).digest('hex')
}

function safeHash(file: string): string | null {
  try {
    return hashFile(file)
  } catch {
    return null
  }
}

export function getFakesStatus(): FakesStatus {
  const dir = binDir()
  const available = existsSync(dir)
  const fakes: FakeFile[] = []
  if (available) {
    for (const name of readdirSync(dir)) {
      if (!/\.bin$/i.test(name)) continue
      if (/^ACTIVE_/i.test(name)) continue
      const full = path.join(dir, name)
      let size = 0
      try {
        size = statSync(full).size
      } catch {
        continue
      }
      const hash = safeHash(full)
      if (!hash) continue
      fakes.push({ name, path: full, hash, size })
    }
  }
  fakes.sort((a, b) => a.name.localeCompare(b.name))

  const slots: Record<FakeKind, ActiveFakeSlot> = {
    discord: { current: null, activePath: path.join(dir, ACTIVE_FILES.discord), exists: false },
    game: { current: null, activePath: path.join(dir, ACTIVE_FILES.game), exists: false }
  }
  for (const kind of Object.keys(ACTIVE_FILES) as FakeKind[]) {
    const activePath = path.join(dir, ACTIVE_FILES[kind])
    const exists = existsSync(activePath)
    const activeHash = exists ? safeHash(activePath) : null
    slots[kind] = {
      current: activeHash ? fakes.find((f) => f.hash === activeHash)?.name ?? null : null,
      activePath,
      exists
    }
  }

  return { available, binDir: dir, fakes, discord: slots.discord, game: slots.game }
}

/**
 * Copy the chosen fake payload over the active file. Windows keeps the old
 * file locked while winws.exe is running (rare for UDP payloads, but
 * possible), so retry after an explicit unlink.
 */
export function replaceActiveFake(kind: FakeKind, fakeName: string): FakesStatus {
  const status = getFakesStatus()
  if (!status.available) {
    throw new Error('Папка bin Zapret не найдена. Установите или обновите Zapret.')
  }
  const fake = status.fakes.find((f) => f.name === fakeName)
  if (!fake) {
    throw new Error(`Файл ${fakeName} не найден в bin.`)
  }
  const target = ACTIVE_FILES[kind]
  if (!target) throw new Error('Неизвестный тип фейка.')
  const activePath = path.join(status.binDir, target)
  try {
    copyFileSync(fake.path, activePath)
  } catch {
    try {
      if (existsSync(activePath)) unlinkSync(activePath)
      copyFileSync(fake.path, activePath)
    } catch (e) {
      throw new Error(
        `Не удалось заменить ${target}: ${e instanceof Error ? e.message : String(e)}. ` +
          'Остановите Zapret и повторите попытку.'
      )
    }
  }
  return getFakesStatus()
}
