/**
 * Single source of truth for the renderer <-> main IPC surface.
 *
 * `INVOKE_CHANNELS` must contain every channel registered with
 * `ipcMain.handle` in `src/main/utils/ipc.ts`; `EVENT_CHANNELS` every
 * channel the main process pushes with `webContents.send`.
 *
 * The preload bridge rejects anything that is not listed here, and
 * `registerIpcMainHandlers` types its handler map as
 * `Record<InvokeChannel, ...>`, so adding a channel on one side without the
 * other fails typecheck instead of silently exposing (or dead-ending) an
 * operation.
 */

export const INVOKE_CHANNELS = Object.freeze([
  // ---- App config ---------------------------------------------------------
  'app:getConfig',
  'app:patchConfig',
  'app:version',

  // ---- Theme --------------------------------------------------------------
  'theme:setNative',
  'theme:apply',

  // ---- Utility ------------------------------------------------------------
  'shell:openTelegramLink',
  'clipboard:writeText',

  // ---- TG WS Proxy --------------------------------------------------------
  // Polling getter. The `tgws:status` *event* below is push-only, so the two
  // namespaces never collide.
  'tgws:getStatus',
  'tgws:start',
  'tgws:stop',
  'tgws:restart',
  'tgws:getLink',
  'tgws:checkUpdate',
  'tgws:installUpdate',
  'tgws:dismissUpdate',

  // ---- Zapret -------------------------------------------------------------
  // Polling getter; `zapret:status` is the push-only event below.
  'zapret:getStatus',
  'zapret:listStrategies',
  'zapret:start',
  'zapret:stop',
  'zapret:restart',
  'zapret:checkUpdate',
  'zapret:installUpdate',
  'zapret:dismissUpdate',

  // ---- Zapret strategy tester --------------------------------------------
  'zapret:runStrategyTest',
  'zapret:cancelStrategyTest',
  'zapret:getStrategyTestResults',
  'zapret:isStrategyTestRunning',

  // ---- Zapret IP list (ipset-all.txt) ------------------------------------
  'zapret:getCuratedIpSets',
  'zapret:getIpList',
  'zapret:applyIpListPatch',
  'zapret:clearIpList',
  'zapret:restoreIpListBackup',

  // ---- Zapret upstream lists (Flowseal repository) -----------------------
  'zapret:getListsStatus',
  'zapret:updateLists',

  // ---- Zapret network filters (game filter + IPSet mode) -----------------
  'zapret:getGameFilter',
  'zapret:setGameFilter',
  'zapret:getIpSetMode',
  'zapret:setIpSetMode',

  // ---- Zapret active fakes ------------------------------------------------
  'zapret:getFakes',
  'zapret:replaceFake',

  // ---- Hosts editor -------------------------------------------------------
  'hosts:overview',
  'hosts:setService',
  'hosts:setDnsForAll',
  'hosts:disableAll',
  'hosts:setAdobe',
  'hosts:importLegacy',
  'hosts:apply',
  'hosts:refreshAddresses',
  'hosts:restoreLatest',
  'hosts:openFile',
  'hosts:flushDns',
  'hosts:updateCatalog',

  // ---- Zapret diagnostics / maintenance -----------------------------------
  'zapret:diagnostics',
  'zapret:diagnosticsFix',
  'zapret:getAutoUpdateCheck',
  'zapret:setAutoUpdateCheck',
  'zapret:runTests',
  'zapret:clearDiscordCache',

  // ---- Wallpaper ----------------------------------------------------------
  'wallpaper:listWorkshop',
  'wallpaper:pick',
  'wallpaper:resolve',
  'wallpaper:openWorkshop',

  // ---- SkipNet self-update ------------------------------------------------
  'app:checkUpdate',
  'app:installUpdate',
  'app:dismissUpdate',

  // ---- Quit / restart -----------------------------------------------------
  'app:quit',
  'app:relaunch',

  // ---- Window controls ----------------------------------------------------
  'windowIsMaximized',
  'windowMinimize',
  'windowMaximize',
  'windowClose'
] as const)

export type InvokeChannel = (typeof INVOKE_CHANNELS)[number]

/** Main -> renderer push messages. None of these may be invoked. */
export const EVENT_CHANNELS = Object.freeze([
  'log',
  'showError',
  'appConfigUpdated',
  'tgws:status',
  'zapret:status',
  'zapret:testProgress',
  'window:visibility',
  'window-maximized',
  'window-unmaximized'
] as const)

export type EventChannel = (typeof EVENT_CHANNELS)[number]

const INVOKE_SET: ReadonlySet<string> = new Set(INVOKE_CHANNELS)
const EVENT_SET: ReadonlySet<string> = new Set(EVENT_CHANNELS)

export function isInvokeChannel(value: unknown): value is InvokeChannel {
  return typeof value === 'string' && INVOKE_SET.has(value)
}

export function isEventChannel(value: unknown): value is EventChannel {
  return typeof value === 'string' && EVENT_SET.has(value)
}
