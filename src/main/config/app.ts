import { readFile, writeFile, copyFile, unlink } from 'fs/promises'
import { appConfigPath } from '../utils/dirs'
import { parseYaml, stringifyYaml } from '../utils/yaml'
import { deepMerge } from '../utils/merge'
import { defaultConfig, CONFIG_VERSION } from '../utils/template'
import { sanitizeAppConfig, validateAppConfigPatch } from './schema'
import { randomBytes, randomUUID } from 'crypto'
import { readFileSync, existsSync } from 'fs'
import { is } from '@electron-toolkit/utils'
import { enableAutoRun, disableAutoRun, type AutoRunResult } from '../sys/autoRun'
import { renameWithRetry } from '../utils/fs-retry'

let appConfig: AppConfig | undefined
let writePromise: Promise<void> = Promise.resolve()

/**
 * Run a config write inside the same serialized queue as `patchAppConfig`.
 *
 * `getAppConfig` performs one-shot migrations (dev build-id reset, production
 * build-id refresh, CONFIG_VERSION migration). Writing those with a bare
 * `safeWriteConfig` raced a concurrent `patchAppConfig`: the migration could
 * overwrite the freshly patched file with its pre-patch snapshot (L8).
 *
 * The YAML is stringified *inside* the queued task, so it always reflects the
 * latest in-memory `appConfig` (including a patch that was merged while the
 * write was waiting for its turn).
 */
function queueConfigWrite(): Promise<void> {
  const previous = writePromise
  writePromise = previous.catch(() => void 0).then(() => {
    if (!appConfig) return
    return safeWriteConfig(stringifyYaml(appConfig))
  })
  return writePromise
}

async function safeWriteConfig(content: string): Promise<void> {
  const configPath = appConfigPath()
  // Random + O_EXCL: a fixed `.tmp` name in userData could be pre-created as a
  // hardlink to a privileged file and be overwritten by this elevated write.
  const tmpPath = `${configPath}.${randomUUID()}.tmp`
  const backupPath = `${configPath}.backup`
  try {
    await writeFile(tmpPath, content, { encoding: 'utf-8', flag: 'wx' })
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
    // AV/indexer handles make Windows fail with EPERM/EBUSY for a few
    // milliseconds — retry those instead of reporting a lost setting.
    await renameWithRetry(tmpPath, configPath)
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
      const parsed = parseYaml<unknown>(data)
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) continue
      if (!('appTheme' in (parsed as object))) continue
      // Allow-list + drop legacy path overrides (`tgws.binaryPath`) and
      // prototype-pollution keys before anything is merged.
      return sanitizeAppConfig(parsed) as AppConfig
    } catch {
      /* try the next candidate */
    }
  }
  return null
}

export async function getAppConfig(force = false): Promise<AppConfig> {
  if (force || !appConfig) {
    appConfig = (await readConfigFromDisk()) ?? structuredClone(defaultConfig)
  }
  if (!appConfig || typeof appConfig !== 'object') appConfig = structuredClone(defaultConfig)

  const persistedVersion: number = typeof appConfig.configVersion === 'number'
    ? appConfig.configVersion
    : 0

  const persistedBuildId = typeof appConfig.lastBuildId === 'string'
    ? appConfig.lastBuildId
    : ''

  // Backfill any missing fields (e.g. tgws/zapret sections from older configs)
  // by merging persisted values *over* the default template.
  //
  // IMPORTANT: merge into a clone. `deepMerge` mutates its target, so using
  // `defaultConfig` directly would permanently bake the user's saved values
  // into the shared template — a later corrupt/missing config would then
  // "restore" the previous user's settings instead of factory defaults.
  appConfig = deepMerge(structuredClone(defaultConfig), appConfig) as AppConfig

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
      await queueConfigWrite()
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
    try { await queueConfigWrite() } catch { /* noop */ }
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
    // patchAppConfig call doesn't roll back the migration. Queued, so a
    // concurrent patch cannot be overwritten by this stale snapshot.
    try {
      await queueConfigWrite()
    } catch { /* noop — migration is best-effort */ }
    // Also tear down any auto-launch task/registry left over from a prior
    // build so SkipNet isn't relaunched on next login against the user's
    // (now-clean) preference.
    try { await disableAutoRun() } catch { /* noop */ }
  }

  return appConfig
}

export async function patchAppConfig(patch: Partial<AppConfig>): Promise<void> {
  // Validate BEFORE taking the write queue: an invalid patch must neither
  // mutate the in-memory config nor reach the disk. Throws
  // `ConfigValidationError` with the offending field path; `ipc.ts` turns it
  // into `{ ok: false, message }`.
  const cleanPatch = validateAppConfigPatch(patch)

  // Run the merge, the disk write and all dependent side effects inside the
  // serialized queue. Values captured *outside* the queue are stale when two
  // patches are fired back-to-back (the renderer does not await them), which
  // made autostart/tray toggles race and skip the matching side effect.
  const apply = async (): Promise<void> => {
    const prevAutoLaunch = appConfig?.autoLaunch
    const prevDisableTray = appConfig?.disableTray
    const prevHideTaskbarIcon = appConfig?.hideTaskbarIcon

    appConfig = deepMerge(appConfig ?? structuredClone(defaultConfig), cleanPatch)
    await safeWriteConfig(stringifyYaml(appConfig))

    // Windows is the source of truth for the logon task. If registration or
    // removal fails, roll the persisted flag back and surface the reason:
    // silently keeping `autoLaunch: true` made the toggle lie until the next
    // failed boot attempt.
    let autoLaunchError: Error | null = null
    if (cleanPatch.autoLaunch !== undefined && cleanPatch.autoLaunch !== prevAutoLaunch) {
      let result: AutoRunResult
      try {
        result = cleanPatch.autoLaunch ? await enableAutoRun() : await disableAutoRun()
      } catch (e) {
        result = { ok: false, message: e instanceof Error ? e.message : String(e) }
      }
      if (!result.ok) {
        appConfig = { ...appConfig, autoLaunch: prevAutoLaunch ?? false }
        try {
          await safeWriteConfig(stringifyYaml(appConfig))
        } catch {
          /* best effort — the in-memory flag already agrees with Windows */
        }
        autoLaunchError = new Error(result.message)
      }
    }
    // React to tray toggle: create or destroy tray on the fly so the user
    // doesn't have to relaunch the app for the change to take effect.
    if (cleanPatch.disableTray !== undefined && cleanPatch.disableTray !== prevDisableTray) {
      try {
        const tray = await import('../resolve/tray')
        if (cleanPatch.disableTray) tray.destroyTray()
        else await tray.createTray()
      } catch { /* noop */ }
    }
    const disableTrayChanged =
      cleanPatch.disableTray !== undefined && cleanPatch.disableTray !== prevDisableTray
    const hideChanged =
      cleanPatch.hideTaskbarIcon !== undefined &&
      cleanPatch.hideTaskbarIcon !== prevHideTaskbarIcon
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

    // Throw only after every side effect and the renderer refresh ran, so the
    // toggle visibly snaps back to the rolled-back value together with the
    // error message.
    if (autoLaunchError) throw autoLaunchError
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
    const data = parseYaml<unknown>(raw)
    if (data && typeof data === 'object' && !Array.isArray(data)) {
      return deepMerge(structuredClone(defaultConfig), sanitizeAppConfig(data)) as AppConfig
    }
    return structuredClone(defaultConfig)
  } catch {
    return structuredClone(defaultConfig)
  }
}
