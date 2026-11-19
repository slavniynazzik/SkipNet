import { is } from '@electron-toolkit/utils'
import { cpSync, copyFileSync, existsSync, mkdirSync, readdirSync } from 'fs'
import { app } from 'electron'
import path from 'path'

/** Optional opt-in marker for a hand-made portable copy. */
const PORTABLE_MARKER = 'PORTABLE'
/** NSIS uninstaller written next to the exe by the installed build. */
const UNINSTALLER_NAMES = ['Uninstall SkipNet.exe', 'uninstall.exe']

/** Normalise a Windows path for a case/separator-insensitive prefix check. */
function normalizeWindowsPath(value: string): string {
  return path.win32.resolve(value).replace(/[\\/]+$/, '').toLowerCase()
}

/**
 * True when `dir` is `%ProgramFiles%`, `%ProgramFiles(x86)%` or inside them.
 *
 * Uses the environment variables instead of the literal English folder names
 * so a localised Windows install is covered too. `path.win32` keeps the check
 * meaningful even when the unit suite runs on a non-Windows host.
 */
export function isUnderProgramFiles(
  dir: string,
  env: NodeJS.ProcessEnv = process.env
): boolean {
  if (typeof dir !== 'string' || !dir.trim()) return false
  const target = normalizeWindowsPath(dir)
  const roots = ['ProgramFiles', 'ProgramW6432', 'ProgramFiles(x86)']
    .map((name) => env[name])
    .filter((value): value is string => typeof value === 'string' && value.trim().length > 0)

  return roots.some((root) => {
    const base = normalizeWindowsPath(root)
    if (!base) return false
    return target === base || target.startsWith(`${base}\\`)
  })
}

/**
 * Detect a portable (unpacked 7z) build from its directory.
 *
 * A portable copy is either explicitly marked with a `PORTABLE` file or — the
 * normal case, because `electron-builder`'s 7z target does not add one — simply
 * lacks the NSIS uninstaller that every installed build has. A copy whose
 * uninstaller is missing but which sits in Program Files is an *installed*
 * build with a damaged directory: treating it as portable would move the
 * profile (and the trusted updater/state) next to the binaries, so Program
 * Files always wins over the "no uninstaller" heuristic (W10).
 *
 * `exists` is injectable so the decision can be unit-tested with temp dirs.
 */
export function detectPortableDir(
  dir: string,
  exists: (candidate: string) => boolean = existsSync,
  env: NodeJS.ProcessEnv = process.env
): boolean {
  if (exists(path.join(dir, PORTABLE_MARKER))) return true
  const hasUninstaller = UNINSTALLER_NAMES.some((name) => exists(path.join(dir, name)))
  if (hasUninstaller) return false
  return !isUnderProgramFiles(dir, env)
}

export function isPortable(): boolean {
  // In dev `exePath()` is electron.exe inside node_modules/electron/dist. It
  // has no uninstaller, so the "no uninstaller" heuristic would move the dev
  // profile into the toolchain folder. Only an explicit marker applies there.
  if (is.dev) return existsSync(path.join(exeDir(), PORTABLE_MARKER))
  return detectPortableDir(exeDir())
}

export function dataDir(): string {
  if (isPortable()) {
    return path.join(exeDir(), 'data')
  }
  return app.getPath('userData')
}

/**
 * One-time migration from the pre-rebrand profile folder.
 *
 * `app.setName('skipnet')` moves userData from `%APPDATA%\slipgate` to
 * `%APPDATA%\skipnet`. Without this copy an update would look like a fresh
 * install: the Telegram secret, chosen strategy, custom lists and downloaded
 * component versions would all be lost. We only fill in a brand-new profile,
 * so once the new folder exists it always wins and is never overwritten.
 */
export function migrateLegacyData(): void {
  if (isPortable()) return
  const appData = app.getPath('appData')
  const current = dataDir()
  const legacyNames = is.dev ? ['slipgate-dev'] : ['slipgate', 'Slipgate']
  for (const name of legacyNames) {
    const legacy = path.join(appData, name)
    if (!existsSync(legacy)) continue
    if (path.resolve(legacy) === path.resolve(current)) continue
    // New profile already initialised -> nothing to migrate.
    if (existsSync(path.join(current, 'config.yaml'))) return
    try {
      mkdirSync(current, { recursive: true })
      for (const file of ['config.yaml', 'config.yaml.backup', 'window-state.json']) {
        const from = path.join(legacy, file)
        const to = path.join(current, file)
        if (existsSync(from) && !existsSync(to)) copyFileSync(from, to)
      }
      for (const entry of readdirSync(legacy)) {
        if (!/^update-cache-.*\.json$/i.test(entry)) continue
        const to = path.join(current, entry)
        if (!existsSync(to)) copyFileSync(path.join(legacy, entry), to)
      }
      for (const dir of ['runtime', 'logs', 'themes']) {
        const from = path.join(legacy, dir)
        const to = path.join(current, dir)
        if (existsSync(from)) {
          cpSync(from, to, { recursive: true, force: false, errorOnExist: false })
        }
      }
    } catch {
      // Best-effort: a failed migration must never block startup. The user
      // keeps a working (fresh) profile instead.
    }
    return
  }
}

export function exeDir(): string {
  return path.dirname(exePath())
}

export function exePath(): string {
  return app.getPath('exe')
}

export function resourcesDir(): string {
  if (is.dev) {
    // In dev __dirname is <project>/out/main, so ../.. resolves to the
    // project root which contains the `resources/` folder with all
    // SkipNet runtime binaries (tgws/, zapret/, icon files).
    const root = path.join(__dirname, '../..')
    return path.join(root, 'resources')
  }
  if (app.getAppPath().endsWith('asar')) {
    return process.resourcesPath
  }
  return path.join(app.getAppPath(), 'resources')
}

export function resourcesFilesDir(): string {
  return path.join(resourcesDir(), 'files')
}

export function themesDir(): string {
  return path.join(dataDir(), 'themes')
}

export function appConfigPath(): string {
  return path.join(dataDir(), 'config.yaml')
}

export function logDir(): string {
  return path.join(dataDir(), 'logs')
}

function pad2(value: number): string {
  return String(value).padStart(2, '0')
}

/** Per-day log file name: `app-YYYY-MM-DD.log` (local time). */
export function logFileName(date = new Date()): string {
  return `app-${date.getFullYear()}-${pad2(date.getMonth() + 1)}-${pad2(date.getDate())}.log`
}

/** Absolute path of the day's log file. */
export function logPath(date = new Date()): string {
  return path.join(logDir(), logFileName(date))
}

/**
 * Legacy location for non-executable leftovers from older releases.
 *
 * Executables are NEVER resolved from here: `%APPDATA%` is writable by any
 * medium-integrity process, while SkipNet runs elevated. Zapret and TgWsProxy
 * always resolve to the bundled resources tree (see `tgwsBinaryPath()` and
 * `zapretBundleDir()`), which is admin-only when installed in Program Files.
 */
export function runtimeDir(): string {
  return path.join(dataDir(), 'runtime')
}

export function tgwsBinaryPath(): string {
  return path.join(resourcesDir(), 'tgws', 'TgWsProxy_windows.exe')
}

export function zapretBundleDir(): string {
  return path.join(resourcesDir(), 'zapret')
}

export function zapretBinaryPath(): string {
  return path.join(zapretBundleDir(), 'bin', 'winws.exe')
}