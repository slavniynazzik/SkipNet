import { is } from '@electron-toolkit/utils'
import { cpSync, copyFileSync, existsSync, mkdirSync, readdirSync } from 'fs'
import { app } from 'electron'
import path from 'path'

export const homeDir = app.getPath('home')

export function isPortable(): boolean {
  return existsSync(path.join(exeDir(), 'PORTABLE'))
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

export function taskDir(): string {
  const dir = path.join(app.getPath('userData'), 'tasks')
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true })
  }
  return dir
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

export function logPath(): string {
  const date = new Date()
  const name = `${date.getFullYear()}-${date.getMonth() + 1}-${date.getDate()}`
  return path.join(logDir(), `${name}.log`)
}

export function runtimeDir(): string {
  return path.join(dataDir(), 'runtime')
}

export function tgwsRuntimeDir(): string {
  return path.join(runtimeDir(), 'tgws')
}

export function tgwsBinaryPath(): string {
  // Check runtime dir first (downloaded updates), fall back to bundled resources/.
  const rt = path.join(tgwsRuntimeDir(), 'TgWsProxy_windows.exe')
  if (existsSync(rt)) return rt
  return path.join(resourcesDir(), 'tgws', 'TgWsProxy_windows.exe')
}

export function zapretRuntimeDir(): string {
  return path.join(runtimeDir(), 'zapret')
}

export function zapretBundleDir(): string {
  const rt = zapretRuntimeDir()
  if (existsSync(path.join(rt, 'general.bat'))) return rt
  return path.join(resourcesDir(), 'zapret')
}

export function zapretBinaryPath(): string {
  return path.join(zapretBundleDir(), 'bin', 'winws.exe')
}