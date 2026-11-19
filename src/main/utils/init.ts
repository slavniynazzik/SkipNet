import {
  appConfigPath,
  dataDir,
  logDir,
  runtimeDir,
  themesDir
} from './dirs'
import { defaultConfig } from './template'
import { stringifyYaml } from './yaml'
import { initAppLog } from './app-logger'
import { mkdir, writeFile, copyFile, rename, unlink } from 'fs/promises'
import { randomUUID } from 'crypto'
import { existsSync } from 'fs'
import { spawn } from 'child_process'
import path from 'path'
import { app } from 'electron'

// URI schemes used by the project before the SkipNet rebrand. Their handler
// keys usually point at a different executable, so the Electron helper below
// cannot remove them on its own — see `clearLegacyProtocols`.
const LEGACY_SCHEMES = ['slipgate'] as const

function deleteRegistryKey(hive: string, key: string): void {
  try {
    const p = spawn('reg.exe', ['delete', `${hive}\\${key}`, '/f'], {
      windowsHide: true,
      stdio: 'ignore'
    })
    p.on('error', () => void 0)
    p.unref()
  } catch {
    /* noop - reg.exe missing or key locked */
  }
}

function clearLegacyProtocols(): void {
  for (const scheme of LEGACY_SCHEMES) {
    // The Electron helper only removes a handler that points at *this* exe.
    // After an in-place upgrade the old key still points at a stale binary,
    // so drop the registry keys directly (HKCU, machine-wide, and the merged
    // HKCR view) before registering the new `skipnet://` handler.
    try {
      app.removeAsDefaultProtocolClient(scheme)
    } catch {
      /* noop - registry may be locked or absent */
    }
    deleteRegistryKey('HKCU', `Software\\Classes\\${scheme}`)
    deleteRegistryKey('HKLM', `Software\\Classes\\${scheme}`)
    deleteRegistryKey('HKCR', scheme)
  }
}

async function initDirs(): Promise<void> {
  if (!existsSync(dataDir())) {
    await mkdir(dataDir(), { recursive: true })
  }
  const dirs = [
    themesDir(),
    logDir(),
    runtimeDir()
  ]
  await Promise.all(
    dirs.map(async (dir) => {
      if (!existsSync(dir)) {
        await mkdir(dir, { recursive: true })
      }
    })
  )
}

async function initConfig(): Promise<void> {
  const configPath = appConfigPath()
  if (existsSync(configPath)) return

  // The primary config vanished (crash between unlink/rename in older builds,
  // an over-eager cleaner or Antivirus quarantine). Restore the last
  // known-good backup instead of silently replacing all user settings with
  // the defaults. Write through a random temp file so a pre-created hardlink
  // at the live path cannot redirect the elevated write.
  const backupPath = `${configPath}.backup`
  const tmpPath = `${configPath}.${randomUUID()}.tmp`
  try {
    if (existsSync(backupPath)) {
      await copyFile(backupPath, tmpPath)
    } else {
      await writeFile(tmpPath, stringifyYaml(defaultConfig), { encoding: 'utf8', flag: 'wx' })
    }
    await rename(tmpPath, configPath)
  } catch {
    try {
      await unlink(tmpPath)
    } catch {
      /* noop */
    }
    await writeFile(tmpPath, stringifyYaml(defaultConfig), { encoding: 'utf8', flag: 'wx' })
    await rename(tmpPath, configPath)
  }
}

function initDeeplink(): void {
  clearLegacyProtocols()
  if (process.defaultApp) {
    if (process.argv.length >= 2) {
      app.setAsDefaultProtocolClient('skipnet', process.execPath, [
        path.resolve(process.argv[1])
      ])
      app.setAsDefaultProtocolClient('tg-ws', process.execPath, [
        path.resolve(process.argv[1])
      ])
    }
  } else {
    app.setAsDefaultProtocolClient('skipnet')
    app.setAsDefaultProtocolClient('tg-ws')
  }
}

export async function init(): Promise<void> {
  await initDirs()
  await initConfig()
  // Prune day files beyond `maxLogDays` before the first line is written.
  await initAppLog()
  initDeeplink()
}