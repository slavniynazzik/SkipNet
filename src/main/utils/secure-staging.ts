/**
 * Admin-only staging directories for files that are verified and then executed.
 *
 * `%TEMP%` / `%APPDATA%` are writable by any process running as the same user,
 * while SkipNet runs elevated. A file that was hashed in memory and then
 * written to a user-writable path can be swapped between the check and the
 * spawn (installer, scheduled-task XML, hosts payload). Staging therefore moves
 * to `%ProgramData%\SkipNet\<kind>`, whose ACL is tightened to SYSTEM and the
 * Administrators group only.
 *
 * Fail-closed: if ProgramData cannot be resolved or `icacls` fails, the caller
 * gets an error. There is no silent fallback to `%TEMP%`.
 */
import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, readdirSync, statSync, unlinkSync } from 'node:fs'
import path from 'node:path'
import { app } from 'electron'
import { is } from '@electron-toolkit/utils'
import { sysBin } from './sys-bin'

export type StagingKind = 'updates' | 'tasks' | 'hosts'

const STAGING_KINDS: readonly StagingKind[] = ['updates', 'tasks', 'hosts']

const KIND_LABELS: Record<StagingKind, string> = {
  updates: 'обновлений',
  tasks: 'задачи автозапуска',
  hosts: 'файла hosts'
}

/**
 * Test seam: suites must never write into the real `%ProgramData%\SkipNet`.
 * Deliberately not backed by an environment variable or the config — nothing
 * the renderer can influence may redirect a privileged staging directory.
 */
let stagingRootOverride: string | null = null

export function setStagingRootForTesting(target: string | null): void {
  stagingRootOverride = target
}

function isDevStaging(): boolean {
  return stagingRootOverride !== null || is.dev
}

/**
 * Machine-wide root. `%ProgramData%` is used verbatim so a relocated
 * (non-system-drive) ProgramData keeps working; only an absolute drive path is
 * accepted, and the environment cannot point it at a UNC share.
 */
export function productionStagingRoot(env: NodeJS.ProcessEnv = process.env): string {
  const programData = (env.ProgramData || env.PROGRAMDATA || '').trim()
  const systemDrive = (env.SystemDrive || '').trim()
  const base =
    programData ||
    (/^[a-zA-Z]:$/.test(systemDrive) ? `${systemDrive}\\ProgramData` : '')
  if (!/^[a-zA-Z]:[\\/]/.test(base)) {
    throw new Error(
      'Не удалось определить системный каталог ProgramData для защищённого ' +
        'хранилища. Запустите SkipNet от имени администратора и повторите попытку.'
    )
  }
  return path.join(path.win32.normalize(base), 'SkipNet')
}

/** Root of the staging tree: `%ProgramData%\SkipNet` (userData in dev). */
export function stagingRoot(): string {
  if (stagingRootOverride) return stagingRootOverride
  if (is.dev) return path.join(app.getPath('userData'), 'staging')
  return productionStagingRoot()
}

function assertKind(kind: string): asserts kind is StagingKind {
  if (!STAGING_KINDS.includes(kind as StagingKind)) {
    throw new Error(`Неизвестный тип защищённого каталога: ${kind}`)
  }
}

/**
 * Pure path helper (no I/O) used by callers and tests:
 * `stagingPath('updates')` -> `%ProgramData%\SkipNet\updates`,
 * `stagingPath('updates', 'x.exe')` -> `...\updates\x.exe`.
 */
export function stagingPath(kind: StagingKind, name?: string): string {
  assertKind(kind)
  const base = path.join(stagingRoot(), kind)
  if (name === undefined) return base
  const value = String(name)
  if (
    !value ||
    value !== path.basename(value) ||
    value.includes('..') ||
    /[\\/:*?"<>|\0]/.test(value)
  ) {
    throw new Error(`Недопустимое имя файла во временном каталоге: ${value}`)
  }
  return path.join(base, value)
}

/**
 * `icacls` arguments that replace inheritance with exactly two ACEs:
 * SYSTEM and the built-in Administrators group, both inheritable. SIDs are
 * used instead of names so the call works on every Windows locale.
 */
export function stagingAclArgs(dir: string): string[] {
  return [
    dir,
    '/inheritance:r',
    '/grant:r',
    '*S-1-5-18:(OI)(CI)F',
    '*S-1-5-32-544:(OI)(CI)F'
  ]
}

function aclErrorDetail(result: {
  status: number | null
  stderr: string | Buffer | null
  error?: Error
}): string {
  if (result.error) return result.error.message
  const stderr = `${result.stderr ?? ''}`.trim()
  if (stderr) return stderr
  return `icacls завершился с кодом ${result.status ?? '?'}`
}

function tightenAcl(dir: string, label: string): void {
  let result: ReturnType<typeof spawnSync>
  try {
    result = spawnSync(sysBin('icacls.exe'), stagingAclArgs(dir), {
      windowsHide: true,
      encoding: 'utf8',
      timeout: 20_000
    })
  } catch (e) {
    throw new Error(
      `Не удалось ограничить доступ к каталогу ${label}: ${
        e instanceof Error ? e.message : String(e)
      }. Запустите SkipNet от имени администратора и повторите попытку.`
    )
  }
  if (result.status === 0) return
  throw new Error(
    `Не удалось ограничить доступ к каталогу ${label}: ${aclErrorDetail(result)}. ` +
      'Запустите SkipNet от имени администратора и повторите попытку.'
  )
}

/** Staged installers/task XML older than this are leftovers from a crash. */
export const STAGING_SWEEP_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000

/**
 * Pure age predicate for the startup staging sweep. Invalid timestamps and
 * non-finite clocks are never "stale": the sweep must not delete a file just
 * because its metadata could not be read.
 */
export function isStaleStagingEntry(
  mtimeMs: number,
  now: number = Date.now(),
  maxAgeMs: number = STAGING_SWEEP_MAX_AGE_MS
): boolean {
  if (!Number.isFinite(mtimeMs) || !Number.isFinite(now)) return false
  return now - mtimeMs > maxAgeMs
}

/**
 * Best-effort startup cleanup of `%ProgramData%\SkipNet\<kind>`.
 *
 * The directory is admin-only (see `secureStagingDir`), so only SkipNet itself
 * can have written there. Downloads/installers that never ran (crash, aborted
 * UAC, failed spawn) would otherwise accumulate forever. Directories are left
 * untouched; only plain files older than seven days are removed.
 */
export function sweepStaleStagingFiles(
  kind: StagingKind = 'updates',
  now: number = Date.now()
): number {
  let dir: string
  try {
    dir = stagingPath(kind)
  } catch {
    return 0
  }
  if (!existsSync(dir)) return 0

  let removed = 0
  try {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (!entry.isFile()) continue
      const file = path.join(dir, entry.name)
      let mtimeMs: number
      try {
        mtimeMs = statSync(file).mtimeMs
      } catch {
        continue
      }
      if (!isStaleStagingEntry(mtimeMs, now)) continue
      try {
        unlinkSync(file)
        removed++
      } catch {
        /* locked by AV/indexer — retried on the next launch */
      }
    }
  } catch {
    /* unreadable staging dir: nothing to sweep */
  }
  return removed
}

/**
 * Create (if needed) and return the admin-only staging directory for `kind`.
 *
 * In development the directory lives under `userData` because the developer
 * account owns it and does not necessarily have an Administrators-only ACL.
 * Anywhere else a failure to create or tighten the directory throws.
 */
export function secureStagingDir(kind: StagingKind): string {
  assertKind(kind)
  const dir = stagingPath(kind)
  const label = KIND_LABELS[kind]
  try {
    mkdirSync(dir, { recursive: true, mode: 0o700 })
  } catch (e) {
    throw new Error(
      `Не удалось создать защищённый каталог для ${label}: ${
        e instanceof Error ? e.message : String(e)
      }. Запустите SkipNet от имени администратора и повторите попытку.`
    )
  }
  if (!isDevStaging()) tightenAcl(dir, label)
  return dir
}
