import { ipcMain, app, shell, clipboard, BrowserWindow } from 'electron'
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
import { execFile } from 'node:child_process'
import { writeFileSync, unlinkSync } from 'node:fs'
import path from 'node:path'
import { isTrustedFrameUrl, type TrustedFrameOptions } from './ipc-trust'
import type { InvokeChannel } from '../../shared/ipc-channels'

//
function logTgError(stage: string, err: Error | null, stderr?: string): void {
  if (!err && !stderr) return
  const msg = err?.message ?? stderr ?? 'unknown'
  console.error(`[openTelegramLink] ${stage}: ${msg.trim()}`)
}

function tryFallbackOpen(url: string): void {
  shell.openExternal(url).catch((e) => logTgError('shell.openExternal', e))
}

function openTgLinkViaScheduler(url: string, fellBack: { v: boolean }): boolean {
  try {
    const taskName = `SkipNet_OpenTG_${Date.now()}_${Math.floor(Math.random() * 10000)}`
    const vbsPath = path.join(app.getPath('temp'), `${taskName}.vbs`)
    const vbsSafeUrl = url.replace(/"/g, '""')
    const vbsContent =
      'On Error Resume Next\r\n' +
      `CreateObject("Shell.Application").ShellExecute "${vbsSafeUrl}"\r\n`
    writeFileSync(vbsPath, vbsContent, 'utf8')

    // Wrap the wscript invocation in a single /TR string. //B = batch
    // mode (suppress all script-engine UI), //Nologo = suppress the
    // WSH banner. Path is double-quoted to survive spaces in %TEMP%.
    const trCommand = `wscript.exe //B //Nologo "${vbsPath}"`

    const cleanup = (): void => {
      execFile(
        'schtasks.exe',
        ['/Delete', '/F', '/TN', taskName],
        { windowsHide: true },
        () => {
          try { unlinkSync(vbsPath) } catch { /* noop */ }
        }
      )
    }

    // /SC ONCE wants a future-ish time. We use the far future so the
    // task never auto-fires; we always trigger via /Run.
    execFile(
      'schtasks.exe',
      [
        '/Create', '/F',
        '/TN', taskName,
        '/TR', trCommand,
        '/SC', 'ONCE',
        '/ST', '23:59',
        '/SD', '01/01/2099',
        '/IT',
        '/RL', 'LIMITED'
      ],
      { windowsHide: true },
      (createErr, _stdout, createStderr) => {
        if (createErr) {
          logTgError('schtasks /Create', createErr, createStderr)
          if (!fellBack.v) {
            fellBack.v = true
            tryFallbackOpen(url)
          }
          try { unlinkSync(vbsPath) } catch { /* noop */ }
          return
        }
        execFile(
          'schtasks.exe',
          ['/Run', '/TN', taskName],
          { windowsHide: true },
          (runErr, _so, runStderr) => {
            if (runErr) {
              logTgError('schtasks /Run', runErr, runStderr)
              if (!fellBack.v) {
                fellBack.v = true
                tryFallbackOpen(url)
              }
            }
            // Delete task + vbs 5 s later (after TG had time to launch).
            setTimeout(cleanup, 5000)
          }
        )
      }
    )
    return true
  } catch (e) {
    logTgError('openTgLinkViaScheduler sync', e as Error)
    return false
  }
}

const TG_INFLIGHT_LOCK_MS = 600
let tgInflightUntil = 0

/**
 * The renderer only ever needs to open a generated `tg://proxy` link, but the
 * handler is reachable with any string. Restrict it to Telegram URLs so it
 * cannot be used to launch an arbitrary local file or protocol handler at the
 * app's (elevated) integrity level.
 */
function isAllowedTelegramUrl(url: string): boolean {
  try {
    const parsed = new URL(url)
    if (parsed.protocol === 'tg:') return true
    return (
      parsed.protocol === 'https:' &&
      (parsed.hostname === 't.me' || parsed.hostname === 'telegram.me')
    )
  } catch {
    return false
  }
}

function openTelegramLink(url: string): Promise<void> {
  if (!isAllowedTelegramUrl(url)) {
    // Never log the URL itself: a proxy link contains the MTProto secret.
    logTgError('rejected url', null, 'unsupported scheme/host')
    return Promise.resolve()
  }
  const now = Date.now()
  if (now < tgInflightUntil) return Promise.resolve()
  tgInflightUntil = now + TG_INFLIGHT_LOCK_MS
  if (process.platform === 'win32') {
    const fellBack = { v: false }
    if (openTgLinkViaScheduler(url, fellBack)) return Promise.resolve()
    if (!fellBack.v) tryFallbackOpen(url)
    return Promise.resolve()
  }
  tryFallbackOpen(url)
  return Promise.resolve()
}

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
async function seal<T>(run: () => Promise<T> | T): Promise<{ ok: true; value: T } | IpcFailure> {
  try {
    return { ok: true, value: await run() }
  } catch (e: unknown) {
    return { ok: false, message: e instanceof Error ? e.message : String(e) }
  }
}

/**
 * Thin wrapper so any unhandled error in an IPC handler is serialised
 * back to the caller as `{ ok: false, message }` instead of crashing.
 */
function h<T>(fn: (...args: unknown[]) => Promise<T> | T) {
  return async (event: Electron.IpcMainInvokeEvent, ...args: unknown[]) => {
    if (!isTrustedSender(event)) return IPC_DENIED
    return seal(() => fn(...args))
  }
}

/**
 * Same guard and `{ ok, value }` envelope as `h`, for handlers that need the
 * calling frame (window controls).
 */
function hWindow<T>(fn: (event: Electron.IpcMainInvokeEvent) => Promise<T> | T) {
  return async (event: Electron.IpcMainInvokeEvent) => {
    if (!isTrustedSender(event)) return IPC_DENIED
    return seal(() => fn(event))
  }
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
    'zapret:diagnostics': h(() => runZapretDiagnostics()),
    'zapret:diagnosticsFix': h((fix) => {
      const id = fix as DiagFixId
      if (id === 'tcpTimestamps') return fixTcpTimestamps()
      if (id === 'windivert') return fixWindivertConflict()
      if (id === 'conflictingBypasses') return removeConflictingBypasses()
      if (id === 'discordCache') {
        const r = clearDiscordCache()
        return {
          ok: r.failed.length === 0,
          message: r.found ? 'Кэш Discord очищен.' : 'Discord не найден.'
        }
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
    'zapret:clearDiscordCache': h(() => clearDiscordCache()),

    // ---- Wallpaper --------------------------------------------------------
    'wallpaper:listWorkshop': h(() => listWorkshopWallpapers(true)),
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
    'app:relaunch': h(() => {
      app.relaunch()
      app.exit(0)
    }),

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
    ipcMain.handle(channel, handlers[channel])
  }
}

/** Legacy export kept so old call-sites compile during transition. */
export function setupIpc(): void {
  registerIpcMainHandlers()
}
