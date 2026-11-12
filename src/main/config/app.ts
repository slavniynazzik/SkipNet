import { readFile, writeFile, rename, copyFile, unlink } from 'fs/promises'
import { appConfigPath } from '../utils/dirs'
import { parseYaml, stringifyYaml } from '../utils/yaml'
import { deepMerge } from '../utils/merge'
import { defaultConfig, CONFIG_VERSION } from '../utils/template'
import { randomBytes } from 'crypto'
import { readFileSync, existsSync } from 'fs'
import { is } from '@electron-toolkit/utils'
import { enableAutoRun, disableAutoRun } from '../sys/autoRun'

let appConfig: AppConfig | undefined
let writePromise: Promise<void> = Promise.resolve()

function isValidConfig(c: unknown): c is AppConfig {
  return !!c && typeof c === 'object' && 'appTheme' in (c as object)
}

async function safeWriteConfig(content: string): Promise<void> {
  const configPath = appConfigPath()
  const tmpPath = `${configPath}.tmp`
  const backupPath = `${configPath}.backup`
  try {
    await writeFile(tmpPath, content, 'utf-8')
    // Keep the last known-good copy before replacing the live file.
    if (existsSync(configPath)) {
      try {
        await copyFile(configPath, backupPath)
      } catch {
        /* noop — the backup is best-effort, the live write still proceeds */
      }
    }
    // `rename` atomically replaces an existing destination on both Windows and
    // POSIX, so the live config is never missing between unlink and rename.
    await rename(tmpPath, configPath)
  } catch (e) {
    if (existsSync(tmpPath)) {
      try { await unlink(tmpPath) } catch { /* noop */ }
    }
    throw e
  }
}

/**
 * Read the live config, falling back to the last known-good backup when the
 * primary file is missing, unreadable or corrupt. Returns `null` when neither
 * copy parses so the caller can use the defaults.
 */
async function readConfigFromDisk(): Promise<AppConfig | null> {
  const candidates = [appConfigPath(), `${appConfigPath()}.backup`]
  for (const file of candidates) {
    try {
      const data = await readFile(file, 'utf-8')
      const parsed = parseYaml<AppConfig>(data)
      if (parsed && isValidConfig(parsed)) return parsed
    } catch {
      /* try the next candidate */
    }
  }
  return null
}

export async function getAppConfig(force = false): Promise<AppConfig> {
  if (force || !appConfig) {
    appConfig = (await readConfigFromDisk()) ?? defaultConfig
  }
  if (!appConfig || typeof appConfig !== 'object') appConfig = defaultConfig

  const persistedVersion: number = typeof appConfig.configVersion === 'number'
    ? appConfig.configVersion
    : 0

  const persistedBuildId = typeof appConfig.lastBuildId === 'string'
    ? appConfig.lastBuildId
    : ''

  // Backfill any missing fields (e.g. tgws/zapret sections from older configs)
  // by merging persisted values *over* the default template.
  appConfig = deepMerge(defaultConfig, appConfig) as AppConfig

  if ((appConfig.appTheme as string) !== 'light' && (appConfig.appTheme as string) !== 'dark') {
    appConfig = { ...appConfig, appTheme: 'dark' }
  }

  // ---- Developer sandbox reset
  // `__BUILD_ID__` is regenerated on every `electron-vite build`. In the dev
  // sandbox this is what we want: a rebuild must not inherit a stale secret,
  // strategy or toggle from the previous run.
  //
  // Production must NOT key any reset off the build id. Every released
  // installer carries a new id, so doing this in prod would silently wipe the
  // user's Telegram secret (breaking every already-shared link), the chosen
  // Zapret strategy, autostart and tray preferences on *every update*.
  // User data is only reset by the explicit `CONFIG_VERSION` migration below.
  if (is.dev && persistedBuildId !== __BUILD_ID__) {
    appConfig = {
      ...appConfig,
      lastBuildId: __BUILD_ID__,
      // Behaviour toggles — forced back to template defaults.
      autoLaunch: false,
      silentStart: false,
      disableTray: false,         // tray ON
      hideTaskbarIcon: false,     // normal taskbar behaviour
      tgws: {
        ...(appConfig.tgws ?? defaultConfig.tgws!),
        enabled: false,
        autoStart: false,
        // Random per-install secret. Evaluated NOW on the end-user's machine,
        // so every install gets a unique key.
        secret: randomBytes(16).toString('hex')
      },
      zapret: {
        ...(appConfig.zapret ?? defaultConfig.zapret!),
        enabled: false,
        autoStart: false,
        // Force the user to consciously pick a strategy in the UI rather
        // than silently inheriting whatever was last used in dev.
        activeStrategy: undefined
      }
    }
    try {
      await safeWriteConfig(stringifyYaml(appConfig))
    } catch { /* noop — best-effort, will retry on next patch */ }
    // Tear down any auto-launch task / registry entry left over from a
    // prior install so the freshly-reset `autoLaunch: false` actually
    // takes effect on the next login.
    try { await disableAutoRun() } catch { /* noop */ }
  }

  // Keep the diagnostic build-id field current in production without touching
  // any user setting (the reset above is deliberately dev-only).
  if (!is.dev && persistedBuildId !== __BUILD_ID__) {
    appConfig = { ...appConfig, lastBuildId: __BUILD_ID__ }
    try { await safeWriteConfig(stringifyYaml(appConfig)) } catch { /* noop */ }
  }

  // ---- One-shot migration
  if (persistedVersion < CONFIG_VERSION) {
    appConfig = {
      ...appConfig,
      configVersion: CONFIG_VERSION,
      // Wipe every "behaviour" toggle so production builds always start
      // identically regardless of what dev runs left behind.
      autoLaunch: false,
      silentStart: false,         // ← critical: stale `true` left the window invisible on launch
      disableTray: false,         // tray icon ON by default — required for hideTaskbarIcon
      hideTaskbarIcon: false,     // normal taskbar behaviour by default
      tgws: {
        ...(appConfig.tgws ?? defaultConfig.tgws!),
        enabled: false,
        autoStart: false,
        // Regenerate a fresh secret + URL on first production launch so the
        // user can't accidentally publish a dev-time secret.
        secret: randomBytes(16).toString('hex')
      },
      zapret: {
        ...(appConfig.zapret ?? defaultConfig.zapret!),
        enabled: false,
        autoStart: false,
        // Force the user to consciously pick a strategy in the UI rather
        // than inheriting a dev-time `general.bat` they may not want.
        activeStrategy: undefined
      }
    }
    // Persist the migrated config immediately so a crash before the next
    // patchAppConfig call doesn't roll back the migration.
    try {
      await safeWriteConfig(stringifyYaml(appConfig))
    } catch { /* noop — migration is best-effort */ }
    // Also tear down any auto-launch task/registry left over from a prior
    // build so SkipNet isn't relaunched on next login against the user's
    // (now-clean) preference.
    try { await disableAutoRun() } catch { /* noop */ }
  }

  return appConfig
}

export async function patchAppConfig(patch: Partial<AppConfig>): Promise<void> {
  // Run the merge, the disk write and all dependent side effects inside the
  // serialized queue. Values captured *outside* the queue are stale when two
  // patches are fired back-to-back (the renderer does not await them), which
  // made autostart/tray toggles race and skip the matching side effect.
  const apply = async (): Promise<void> => {
    const prevAutoLaunch = appConfig?.autoLaunch
    const prevDisableTray = appConfig?.disableTray
    const prevHideTaskbarIcon = appConfig?.hideTaskbarIcon

    appConfig = deepMerge(appConfig ?? defaultConfig, patch)
    await safeWriteConfig(stringifyYaml(appConfig))

    if (patch.autoLaunch !== undefined && patch.autoLaunch !== prevAutoLaunch) {
      try {
        if (patch.autoLaunch) await enableAutoRun()
        else await disableAutoRun()
      } catch { /* noop */ }
    }
    // React to tray toggle: create or destroy tray on the fly so the user
    // doesn't have to relaunch the app for the change to take effect.
    if (patch.disableTray !== undefined && patch.disableTray !== prevDisableTray) {
      try {
        const tray = await import('../resolve/tray')
        if (patch.disableTray) tray.destroyTray()
        else await tray.createTray()
      } catch { /* noop */ }
    }
    const disableTrayChanged =
      patch.disableTray !== undefined && patch.disableTray !== prevDisableTray
    const hideChanged =
      patch.hideTaskbarIcon !== undefined && patch.hideTaskbarIcon !== prevHideTaskbarIcon
    if (hideChanged || disableTrayChanged) {
      try {
        const { applySkipTaskbar } = await import('../resolve/windowVisibility')
        applySkipTaskbar()
      } catch { /* noop */ }
    }

    // Notify every renderer so config written by the main process (component
    // installers, secret regeneration, update dismissal) refreshes the UI
    // immediately instead of waiting for a route remount.
    try {
      const { BrowserWindow } = await import('electron')
      for (const win of BrowserWindow.getAllWindows()) {
        if (!win.isDestroyed()) win.webContents.send('appConfigUpdated')
      }
    } catch { /* noop */ }
  }

  const previous = writePromise
  // Recover from a previously failed write instead of poisoning the queue:
  // without the catch every later patch would reject before touching disk.
  writePromise = previous.catch(() => void 0).then(apply)
  await writePromise
}

export function getAppConfigSync(): AppConfig {
  try {
    const raw = readFileSync(appConfigPath(), 'utf-8')
    const data = parseYaml<AppConfig>(raw)
    if (data && typeof data === 'object') return deepMerge(defaultConfig, data) as AppConfig
    return defaultConfig
  } catch {
    return defaultConfig
  }
}