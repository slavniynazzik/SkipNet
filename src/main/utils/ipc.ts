import { ipcMain, app, clipboard, BrowserWindow } from 'electron'
import { getAppConfig, patchAppConfig } from '../config'
import { applyTheme, setNativeTheme } from '../resolve/theme'
import {
  getTgwsStatus,
  startTgws,
  stopTgws,
  restartTgws,
  getTgwsLink
} from '../core/tgws'
import {
  getZapretStatus,
  startZapret,
  stopZapret,
  restartZapret,
  listStrategies
} from '../core/zapret'
import {
  checkZapretUpdate,
  installZapretUpdate,
  dismissZapretUpdate
} from '../core/zapret-updater'
import {
  runStrategyTests,
  cancelStrategyTest,
  getStrategyTestResults,
  isStrategyTestRunning
} from '../core/zapret-tester'
import {
  getCuratedIpSets,
  getIpListSnapshot,
  applyIpListPatch,
  clearIpList,
  restoreIpListBackup,
  type IpListPatch
} from '../core/zapret-iplist'
import {
  getZapretListsStatus,
  updateZapretLists,
  getIpSetModeStatus,
  setIpSetMode,
  type IpSetMode,
  type ZapretListsScope
} from '../core/zapret-lists'
import {
  getGameFilterSettings,
  setGameFilter,
  type SetGameFilterInput
} from '../core/zapret-settings'
import { getFakesStatus, replaceActiveFake, type FakeKind } from '../core/zapret-fakes'
import {
  disableAllHostsServices,
  flushHostsDns,
  getHostsOverview,
  importLegacyHostsBlocks,
  openHostsFile,
  reapplyHostsState,
  refreshHostsAddresses,
  refreshHostsCatalog,
  restoreLatestHostsBackup,
  setHostsAdobeBlock,
  setHostsDnsForAll,
  setHostsServiceSelection
} from '../core/hosts-editor'
import {
  listWorkshopWallpapers,
  openWorkshopItem,
  pickWallpaperFile,
  resolveWallpaper
} from '../core/wallpaper'
import {
  runZapretDiagnostics,
  fixTcpTimestamps,
  fixWindivertConflict,
  removeConflictingBypasses,
  getAutoUpdateCheck,
  setAutoUpdateCheck,
  runZapretTests,
  clearDiscordCache,
  type DiagFixId
} from '../core/zapret-diagnostics'
import {
  checkTgwsUpdate,
  installTgwsUpdate,
  dismissTgwsUpdate
} from '../core/tgws-updater'
import {
  checkAppUpdate,
  installAppUpdate,
  dismissAppUpdate
} from '../core/app-updater'
import path from 'node:path'
import { isTrustedFrameUrl, type TrustedFrameOptions } from './ipc-trust'
import { appLog } from './app-logger'
import { openTelegramLink } from './telegram-launch'
import type { InvokeChannel } from '../../shared/ipc-channels'

interface IpcFailure {
  ok: false
  message: string
}

type IpcHandler = (
  event: Electron.IpcMainInvokeEvent,
  ...args: unknown[]
) => Promise<unknown> | unknown

const IPC_DENIED: IpcFailure = { ok: false, message: 'IPC rejected: untrusted sender' }

function trustedFrameOptions(): TrustedFrameOptions {
  return {
    devUrl: process.env['ELECTRON_RENDERER_URL'],
    prodIndexPath: path.join(__dirname, '../renderer/index.html')
  }
}

/**
 * Only the top-level SkipNet frame may invoke privileged handlers. A remote
 * page — or a subframe — that somehow ends up in this BrowserWindow must not
 * be able to write hosts, install updates or start processes.
 */
function isTrustedSender(event: Electron.IpcMainInvokeEvent): boolean {
  const frame = event.senderFrame
  if (!frame) return false
  // Nested frames (iframes, webviews) never get the IPC surface.
  if (frame !== event.sender.mainFrame) return false
  return isTrustedFrameUrl(frame.url, trustedFrameOptions())
}

/** Serialise success/failure without leaking exceptions across IPC. */
function sealFailure(error: unknown): IpcFailure {
  return {
    ok: false,
    message: error instanceof Error ? error.message : String(error)
  }
}

/**
 * Marks a handler that ignores the IPC event. Trust checking and the
 * `{ ok, value }` envelope are applied by `registerHandler`, where the channel
 * name is known and can be included in the error log.
 */
function h<T>(fn: (...args: unknown[]) => Promise<T> | T): IpcHandler {
  return (_event, ...args) => fn(...args)
}

/** Same for handlers that need the calling frame (window controls). */
function hWindow<T>(
  fn: (event: Electron.IpcMainInvokeEvent) => Promise<T> | T
): IpcHandler {
  return (event) => fn(event)
}

/**
 * Relaunch requested from the renderer.
 *
 * The flag lives here (not in `index.ts`) so the IPC handler does not import
 * the main entry point — that would be a circular import. `index.ts` reads it
 * from `will-quit`, *after* `before-quit` cleanup has stopped the children, and
 * only then spawns the new instance.
 */
let relaunchRequested = false

export function requestRelaunch(): void {
  relaunchRequested = true
  // A graceful quit so `before-quit` can stop TgWs/Zapret first. Calling
  // `app.exit(0)` here was the CA3 bug: it skipped cleanup and orphaned
  // winws.exe on the next start.
  app.quit()
}

export function isRelaunchRequested(): boolean {
  return relaunchRequested
}

/**
 * Register one allow-listed channel.
 *
 * Every handler runs behind: (1) the exact-frame trust check, (2) a
 * `{ ok: true, value }` envelope, and (3) structured error logging with the
 * channel, message and stack. Logging here (instead of inside `h`) is what
 * makes `{channel, message, stack}` available for every failure.
 */
function registerHandler(channel: InvokeChannel, handler: IpcHandler): void {
  ipcMain.handle(channel, async (event, ...args) => {
    if (!isTrustedSender(event)) return IPC_DENIED
    try {
      return { ok: true, value: await handler(event, ...args) }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      const stack = error instanceof Error ? (error.stack ?? message) : message
      appLog('error', `IPC ${channel} failed: ${JSON.stringify({ channel, message, stack })}`)
      return sealFailure(error)
    }
  })
}

/**
 * Every privileged operation, keyed by the channel the preload allow-list
 * exports. Typing the map as `Record<InvokeChannel, IpcHandler>` makes a
 * mismatch between `src/shared/ipc-channels.ts` and this file a typecheck
 * error in both directions: a missing channel and a channel the preload
 * cannot reach are both rejected by the compiler.
 */
export function registerIpcMainHandlers(): void {
  const handlers: Record<InvokeChannel, IpcHandler> = {
    // ---- App config -------------------------------------------------------
    'app:getConfig': h(() => getAppConfig()),
    'app:patchConfig': h((patch) => patchAppConfig(patch as Partial<AppConfig>)),
    'app:version': h(() => app.getVersion()),

    // ---- Theme ------------------------------------------------------------
    'theme:setNative': h((theme) => setNativeTheme(theme as AppTheme)),
    'theme:apply': h((file) => applyTheme(file as string)),

    // ---- Utility ----------------------------------------------------------
    'shell:openTelegramLink': h((url) => openTelegramLink(url as string)),
    'clipboard:writeText': h((text) => { clipboard.writeText(text as string) }),

    // ---- TG WS Proxy ------------------------------------------------------
    'tgws:getStatus': h(() => getTgwsStatus()),
    'tgws:start': h(() => startTgws()),
    'tgws:stop': h(() => stopTgws()),
    'tgws:restart': h(() => restartTgws()),
    'tgws:getLink': h(() => getTgwsLink()),
    'tgws:checkUpdate': h((force) => checkTgwsUpdate(Boolean(force))),
    'tgws:installUpdate': h((tag) => installTgwsUpdate(String(tag ?? ''))),
    'tgws:dismissUpdate': h((tag) => dismissTgwsUpdate(tag as string)),

    // ---- Zapret -----------------------------------------------------------
    'zapret:getStatus': h(() => getZapretStatus()),
    'zapret:listStrategies': h(() => listStrategies()),
    'zapret:start': h(() => startZapret()),
    'zapret:stop': h(() => stopZapret()),
    'zapret:restart': h(() => restartZapret()),
    'zapret:checkUpdate': h((force) => checkZapretUpdate(Boolean(force))),
    'zapret:installUpdate': h((tag) => installZapretUpdate(String(tag ?? ''))),
    'zapret:dismissUpdate': h((tag) => dismissZapretUpdate(tag as string)),

    // ---- Zapret strategy tester ------------------------------------------
    'zapret:runStrategyTest': h(() => runStrategyTests()),
    'zapret:cancelStrategyTest': h(() => cancelStrategyTest('user')),
    'zapret:getStrategyTestResults': h(() => getStrategyTestResults()),
    'zapret:isStrategyTestRunning': h(() => isStrategyTestRunning()),

    // ---- Zapret IP list (ipset-all.txt) ----------------------------------
    'zapret:getCuratedIpSets': h(() => getCuratedIpSets()),
    'zapret:getIpList': h(() => getIpListSnapshot()),
    'zapret:applyIpListPatch': h((patch) => applyIpListPatch((patch ?? {}) as IpListPatch)),
    'zapret:clearIpList': h(() => clearIpList()),
    'zapret:restoreIpListBackup': h(() => restoreIpListBackup()),

    // ---- Zapret upstream lists (Flowseal repository) ---------------------
    'zapret:getListsStatus': h(() => getZapretListsStatus()),
    'zapret:updateLists': h((scope) => {
      const value = scope === 'hosts' || scope === 'ip' || scope === 'all' ? scope : 'all'
      return updateZapretLists(value as ZapretListsScope)
    }),

    // ---- Zapret network filters (game filter + IPSet mode) ---------------
    'zapret:getGameFilter': h(async () => {
      const cfg = await getAppConfig()
      return getGameFilterSettings(cfg.zapret)
    }),
    'zapret:setGameFilter': h((patch) => setGameFilter((patch ?? {}) as SetGameFilterInput)),
    'zapret:getIpSetMode': h(() => getIpSetModeStatus()),
    'zapret:setIpSetMode': h((mode) => {
      const value: IpSetMode =
        mode === 'none' || mode === 'loaded' || mode === 'any' ? mode : 'loaded'
      return setIpSetMode(value)
    }),

    // ---- Zapret active fakes ----------------------------------------------
    'zapret:getFakes': h(() => getFakesStatus()),
    'zapret:replaceFake': h((kind, name) => {
      const value: FakeKind = kind === 'game' ? 'game' : 'discord'
      return replaceActiveFake(value, String(name ?? ''))
    }),

    // ---- Hosts editor -----------------------------------------------------
    'hosts:overview': h(() => getHostsOverview()),
    'hosts:setService': h((id, value) => setHostsServiceSelection(String(id ?? ''), value)),
    'hosts:setDnsForAll': h((profile) => setHostsDnsForAll(String(profile ?? ''))),
    'hosts:disableAll': h(() => disableAllHostsServices()),
    'hosts:setAdobe': h((enabled) => setHostsAdobeBlock(Boolean(enabled))),
    'hosts:importLegacy': h(() => importLegacyHostsBlocks()),
    'hosts:apply': h((force) => reapplyHostsState(force === true)),
    'hosts:refreshAddresses': h(() => refreshHostsAddresses()),
    'hosts:restoreLatest': h(() => restoreLatestHostsBackup()),
    'hosts:openFile': h(() => openHostsFile()),
    'hosts:flushDns': h(() => flushHostsDns()),
    'hosts:updateCatalog': h(() => refreshHostsCatalog()),

    // ---- Zapret diagnostics / maintenance ---------------------------------
    // Destructive fixes are no-ops unless the renderer passes `confirmed`
    // after showing the exact action list (C9). The allow-list and the
    // `{ ok, value }` envelope stay unchanged.
    'zapret:diagnostics': h(() => runZapretDiagnostics()),
    'zapret:diagnosticsFix': h((fix, confirmed) => {
      const id = fix as DiagFixId
      const options = { confirmed: confirmed === true }
      if (id === 'tcpTimestamps') return fixTcpTimestamps(options)
      if (id === 'windivert') return fixWindivertConflict(options)
      if (id === 'conflictingBypasses') return removeConflictingBypasses(options)
      if (id === 'discordCache') {
        const r = clearDiscordCache(options)
        return { ok: r.ok, message: r.message, actions: r.actions }
      }
      return { ok: false, message: 'Неизвестное действие.' }
    }),
    'zapret:getAutoUpdateCheck': h(() => getAutoUpdateCheck()),
    'zapret:setAutoUpdateCheck': h(async (enabled) => {
      const value = Boolean(enabled)
      const actual = setAutoUpdateCheck(value)
      const cfg = await getAppConfig()
      if (cfg.zapret) {
        await patchAppConfig({ zapret: { ...(cfg.zapret as ZapretConfig), checkUpdates: value } })
      }
      return actual
    }),
    'zapret:runTests': h(() => runZapretTests()),
    'zapret:clearDiscordCache': h((confirmed) =>
      clearDiscordCache({ confirmed: confirmed === true })
    ),

    // ---- Wallpaper --------------------------------------------------------
    // Cache is honoured by default; only the explicit «Обновить список»
    // button passes `true` to force a rescan (CA10).
    'wallpaper:listWorkshop': h((force) => listWorkshopWallpapers(force === true)),
    'wallpaper:pick': h(() => pickWallpaperFile()),
    'wallpaper:resolve': h(async () => {
      const cfg = await getAppConfig()
      return resolveWallpaper(cfg.wallpaper)
    }),
    'wallpaper:openWorkshop': h((id) => openWorkshopItem(String(id ?? ''))),

    // ---- SkipNet self-update ----------------------------------------------
    'app:checkUpdate': h((force) => checkAppUpdate(Boolean(force))),
    'app:installUpdate': h((tag) => installAppUpdate(String(tag ?? ''))),
    'app:dismissUpdate': h((tag) => dismissAppUpdate(tag as string)),

    // ---- Quit / restart ---------------------------------------------------
    'app:quit': h(() => app.quit()),
    'app:relaunch': h(() => requestRelaunch()),

    // ---- Window controls (window-controls.tsx) ----------------------------
    'windowIsMaximized': hWindow(
      (event) => BrowserWindow.fromWebContents(event.sender)?.isMaximized() ?? false
    ),
    'windowMinimize': hWindow((event) => {
      BrowserWindow.fromWebContents(event.sender)?.minimize()
    }),
    'windowMaximize': hWindow((event) => {
      const win = BrowserWindow.fromWebContents(event.sender)
      if (!win) return
      if (win.isMaximized()) win.unmaximize()
      else win.maximize()
    }),
    'windowClose': hWindow((event) => {
      BrowserWindow.fromWebContents(event.sender)?.close()
    })
  }

  for (const channel of Object.keys(handlers) as InvokeChannel[]) {
    registerHandler(channel, handlers[channel])
  }
}

/** Legacy export kept so old call-sites compile during transition. */
export function setupIpc(): void {
  registerIpcMainHandlers()
}
