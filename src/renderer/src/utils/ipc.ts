import type { AppConfigPatch } from '@renderer/lib/config-patch'

interface IpcResult<T> {
  ok: boolean
  value?: T
  message?: string
}

async function invoke<T>(channel: string, ...args: unknown[]): Promise<T> {
  const res = await window.skipnet.invoke<IpcResult<T>>(channel, ...args)
  if (!res || !res.ok) {
    throw new Error(res?.message ?? `IPC ${channel} failed`)
  }
  return res.value as T
}

// ---- App config -------------------------------------------------------------
export const getAppConfig = (): Promise<AppConfig> => invoke('app:getConfig')
export const patchAppConfig = (patch: AppConfigPatch): Promise<void> =>
  invoke('app:patchConfig', patch)
export const getAppVersion = (): Promise<string> => invoke('app:version')

// ---- Theme ------------------------------------------------------------------
export const setNativeTheme = (theme: AppTheme): Promise<void> =>
  invoke('theme:setNative', theme)
export const applyTheme = (file: string): Promise<void> => invoke('theme:apply', file)

// ---- Utility ----------------------------------------------------------------
export const openTelegramLink = (url: string): Promise<void> => invoke('shell:openTelegramLink', url)
export const writeClipboard = (text: string): Promise<void> =>
  invoke('clipboard:writeText', text)

// ---- TG WS Proxy ------------------------------------------------------------
export const tgwsStatus = (): Promise<CoreStatus> => invoke('tgws:getStatus')
export const tgwsStart = (): Promise<void> => invoke('tgws:start')
export const tgwsStop = (): Promise<void> => invoke('tgws:stop')
export const tgwsRestart = (): Promise<void> => invoke('tgws:restart')
export const tgwsGetLink = (): Promise<string> => invoke('tgws:getLink')

export interface TgwsUpdateInfo {
  installed?: string
  latest?: string
  tag?: string
  hasUpdate: boolean
  assetName?: string
  releaseUrl?: string
  publishedAt?: string
  dismissed?: boolean
}
export const tgwsCheckUpdate = (force = false): Promise<TgwsUpdateInfo> =>
  invoke('tgws:checkUpdate', force)
export const tgwsInstallUpdate = (
  tag: string
): Promise<{ installedVersion?: string; sizeBytes: number }> =>
  invoke('tgws:installUpdate', tag)
export const tgwsDismissUpdate = (tag: string): Promise<void> =>
  invoke('tgws:dismissUpdate', tag)

// ---- Zapret -----------------------------------------------------------------
export const zapretStatus = (): Promise<CoreStatus> => invoke('zapret:getStatus')
export const zapretListStrategies = (): Promise<{ file: string; title: string; description: string }[]> =>
  invoke('zapret:listStrategies')
export const zapretStart = (): Promise<void> => invoke('zapret:start')
export const zapretStop = (): Promise<void> => invoke('zapret:stop')
export const zapretRestart = (): Promise<void> => invoke('zapret:restart')

export interface ZapretUpdateInfo {
  installed?: string
  latest?: string
  tag?: string
  hasUpdate: boolean
  assetName?: string
  releaseUrl?: string
  publishedAt?: string
  dismissed?: boolean
}
export const zapretCheckUpdate = (force = false): Promise<ZapretUpdateInfo> =>
  invoke('zapret:checkUpdate', force)
export const zapretInstallUpdate = (
  tag: string
): Promise<{ strategies: number; installedVersion?: string }> =>
  invoke('zapret:installUpdate', tag)
export const zapretDismissUpdate = (tag: string): Promise<void> =>
  invoke('zapret:dismissUpdate', tag)

// ---- Zapret strategy tester -------------------------------------------------
// Mirrors the upstream `test zapret.ps1` analytics (HTTP OK / ERR / UNSUP,
// ping OK / Fail) so the GUI shows the same numbers as the console report.
export type HttpCheckStatus = 'ok' | 'error' | 'unsup' | 'ssl'
export interface StrategyTargetResult {
  name: string
  isUrl: boolean
  checks: { label: 'HTTP' | 'TLS1.2' | 'TLS1.3'; status: HttpCheckStatus }[]
  ping: 'ok' | 'fail' | 'n/a'
  pingMs?: number
}
export interface StrategyTestResult {
  tested: true
  /** At least one HTTP/TLS check succeeded (upstream's primary metric). */
  passed: boolean
  okCount: number
  errorCount: number
  unsupportedCount: number
  pingOkCount: number
  pingFailCount: number
  totalCount: number
  score: number
  targets: StrategyTargetResult[]
}
export interface StrategyTestReport {
  ranAt: number
  durationMs: number
  bundleVersion?: string
  results: Record<string, StrategyTestResult>
  bestStrategy?: string
  /** True when the sweep was stopped early (cancel, deadline or pre-empt). */
  cancelled?: boolean
  mode?: 'standard'
}
export interface StrategyTestProgress {
  phase: 'starting' | 'testing' | 'completed' | 'error' | 'idle'
  current?: number
  total?: number
  strategy?: string
  report?: StrategyTestReport
  message?: string
}
export const zapretRunStrategyTest = (): Promise<StrategyTestReport> =>
  invoke('zapret:runStrategyTest')
/** Abort the sweep in flight. Resolves false when nothing was running. */
export const zapretCancelStrategyTest = (): Promise<boolean> =>
  invoke('zapret:cancelStrategyTest')
export const zapretGetStrategyTestResults = (): Promise<StrategyTestReport | null> =>
  invoke('zapret:getStrategyTestResults')
export const zapretIsStrategyTestRunning = (): Promise<boolean> =>
  invoke('zapret:isStrategyTestRunning')

// ---- Zapret IP list (ipset-all.txt) ----------------------------------------
export interface CuratedIpSet {
  id: string
  name: string
  description: string
  cidrs: string[]
}
export interface IpListSnapshot {
  total: number
  preview: string[]
  hasBackup: boolean
  filePath: string
}
export interface IpListPatch {
  setIds?: string[]
  customCidrs?: string[]
  replace?: boolean
}
export const zapretGetCuratedIpSets = (): Promise<CuratedIpSet[]> =>
  invoke('zapret:getCuratedIpSets')
export const zapretGetIpList = (): Promise<IpListSnapshot> => invoke('zapret:getIpList')
export const zapretApplyIpListPatch = (patch: IpListPatch): Promise<IpListSnapshot> =>
  invoke('zapret:applyIpListPatch', patch)
export const zapretClearIpList = (): Promise<IpListSnapshot> => invoke('zapret:clearIpList')
export const zapretRestoreIpListBackup = (): Promise<IpListSnapshot> =>
  invoke('zapret:restoreIpListBackup')

// ---- Zapret upstream lists (Flowseal repository) ---------------------------
export type ZapretListsScope = 'hosts' | 'ip' | 'all'
export interface ZapretListFileStatus {
  id: string
  name: string
  file: string
  path: string
  exists: boolean
  entries: number
  bytes: number
  updatedAt?: string
}
export interface ZapretListsStatus {
  dir: string
  available: boolean
  source: string
  files: ZapretListFileStatus[]
}
export interface ZapretListsUpdateResult {
  updated: Array<{
    id: string
    name: string
    file: string
    entries: number
    bytes: number
  }>
  totalEntries: number
  status: ZapretListsStatus
}
export const zapretGetListsStatus = (): Promise<ZapretListsStatus> =>
  invoke('zapret:getListsStatus')
export const zapretUpdateLists = (
  scope: ZapretListsScope = 'all'
): Promise<ZapretListsUpdateResult> => invoke('zapret:updateLists', scope)

// ---- Zapret network filters (game filter + IPSet mode) --------------------
export type GameFilterMode = 'disabled' | 'all' | 'tcp' | 'udp'
export interface GameFilterSettings {
  mode: GameFilterMode
  tcpRange: string
  udpRange: string
  enabled: boolean
}
export interface SetGameFilterResult extends GameFilterSettings {
  applied: boolean
}
export interface SetGameFilterInput {
  mode?: GameFilterMode
  tcpRange?: string
  udpRange?: string
}
export const zapretGetGameFilter = (): Promise<GameFilterSettings> =>
  invoke('zapret:getGameFilter')
export const zapretSetGameFilter = (
  patch: SetGameFilterInput
): Promise<SetGameFilterResult> => invoke('zapret:setGameFilter', patch)

export type IpSetMode = 'none' | 'loaded' | 'any'
export interface IpSetModeStatus {
  mode: IpSetMode
  entries: number
  hasBackup: boolean
  file: string
}
export const zapretGetIpSetMode = (): Promise<IpSetModeStatus> =>
  invoke('zapret:getIpSetMode')
export const zapretSetIpSetMode = (mode: IpSetMode): Promise<IpSetModeStatus> =>
  invoke('zapret:setIpSetMode', mode)

// ---- Zapret active fakes --------------------------------------------------
export type FakeKind = 'discord' | 'game'
export interface FakeFile {
  name: string
  path: string
  hash: string
  size: number
}
export interface ActiveFakeSlot {
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
export const zapretGetFakes = (): Promise<FakesStatus> => invoke('zapret:getFakes')
export const zapretReplaceFake = (kind: FakeKind, name: string): Promise<FakesStatus> =>
  invoke('zapret:replaceFake', kind, name)

// ---- Hosts editor ----------------------------------------------------------
export const hostsGetOverview = (): Promise<HostsOverview> => invoke('hosts:overview')
export const hostsSetService = (
  id: string,
  value: HostsSelection
): Promise<HostsOperationResult> => invoke('hosts:setService', id, value)
export const hostsSetDnsForAll = (profile: string): Promise<HostsOperationResult> =>
  invoke('hosts:setDnsForAll', profile)
export const hostsDisableAll = (): Promise<HostsOperationResult> => invoke('hosts:disableAll')
export const hostsSetAdobe = (enabled: boolean): Promise<HostsOperationResult> =>
  invoke('hosts:setAdobe', enabled)
export const hostsImportLegacy = (): Promise<HostsOperationResult> =>
  invoke('hosts:importLegacy')
export const hostsApply = (force = false): Promise<HostsOperationResult> =>
  invoke('hosts:apply', force)
export const hostsRefreshAddresses = (): Promise<HostsOperationResult> =>
  invoke('hosts:refreshAddresses')
export const hostsRestoreLatest = (): Promise<HostsOperationResult> =>
  invoke('hosts:restoreLatest')
export const hostsOpenFile = (): Promise<void> => invoke('hosts:openFile')
export interface DnsFlushResult {
  ok: boolean
  message: string
  /** Optional extra diagnostics returned by newer main-process builds. */
  pwa?: string
  runtime?: string
}
export const hostsFlushDns = (): Promise<DnsFlushResult> => invoke('hosts:flushDns')
export const hostsUpdateCatalog = (): Promise<HostsCatalogUpdateResult> =>
  invoke('hosts:updateCatalog')

// ---- Zapret diagnostics / maintenance --------------------------------------
export type DiagStatus = 'ok' | 'warn' | 'fail' | 'info'
export type DiagFixId = 'tcpTimestamps' | 'windivert' | 'conflictingBypasses' | 'discordCache'
export type DiagActionKind = 'service' | 'process' | 'path' | 'command'
export interface DiagAction {
  kind: DiagActionKind
  target: string
  details: string
}
export interface DiagCheck {
  id: string
  title: string
  status: DiagStatus
  detail?: string
  hint?: string
  fix?: DiagFixId
}
export interface DiagnosticsReport {
  generatedAt: number
  checks: DiagCheck[]
  actions: DiagAction[]
}
export interface DiagnosticsFixResult {
  ok: boolean
  message: string
  actions?: DiagAction[]
}
export interface RunTestsResult {
  started: boolean
  script: string
  message: string
}
export interface DiscordCacheResult {
  ok: boolean
  message: string
  closed: string[]
  cleared: string[]
  failed: string[]
  found: boolean
  actions: DiagAction[]
}
export const zapretRunDiagnostics = (): Promise<DiagnosticsReport> =>
  invoke('zapret:diagnostics')
export const zapretDiagnosticsFix = (
  fix: DiagFixId,
  confirmed = false
): Promise<DiagnosticsFixResult> => invoke('zapret:diagnosticsFix', fix, confirmed)
export const zapretGetAutoUpdateCheck = (): Promise<boolean> =>
  invoke('zapret:getAutoUpdateCheck')
export const zapretSetAutoUpdateCheck = (enabled: boolean): Promise<boolean> =>
  invoke('zapret:setAutoUpdateCheck', enabled)
export const zapretRunTests = (): Promise<RunTestsResult> => invoke('zapret:runTests')
export const zapretClearDiscordCache = (confirmed = false): Promise<DiscordCacheResult> =>
  invoke('zapret:clearDiscordCache', confirmed)

// ---- SkipNet self-update ---------------------------------------------------
export interface AppUpdateInfo {
  installed: string
  latest?: string
  hasUpdate: boolean
  tag?: string
  releaseUrl?: string
  releaseNotes?: string
  publishedAt?: string
  dismissed?: boolean
}
export const appCheckUpdate = (force = false): Promise<AppUpdateInfo> =>
  invoke('app:checkUpdate', force)
export const appInstallUpdate = (tag: string): Promise<{ scheduled: true }> =>
  invoke('app:installUpdate', tag)
export const appDismissUpdate = (tag: string): Promise<void> =>
  invoke('app:dismissUpdate', tag)

// ---- Wallpaper -------------------------------------------------------------
export interface WorkshopWallpaper {
  id: string
  title: string
  type: string
  playable: boolean
  mediaPath: string
  previewPath?: string
  dir: string
}
export interface WallpaperState {
  enabled: boolean
  kind: 'none' | 'image' | 'video'
  url?: string
  previewUrl?: string
  title?: string
  note?: string
  opacity: number
  blur: number
  dim: number
}
export interface WallpaperPickResult {
  path?: string
  name?: string
}
export const wallpaperListWorkshop = (force = false): Promise<WorkshopWallpaper[]> =>
  invoke('wallpaper:listWorkshop', force)
export const wallpaperPick = (): Promise<WallpaperPickResult> => invoke('wallpaper:pick')
export const wallpaperResolve = (): Promise<WallpaperState> => invoke('wallpaper:resolve')
export const wallpaperOpenWorkshop = (id: string): Promise<void> =>
  invoke('wallpaper:openWorkshop', id)

// ---- App control ------------------------------------------------------------
export const appQuit = (): Promise<void> => invoke('app:quit')
export const appRelaunch = (): Promise<void> => invoke('app:relaunch')

// ---- Window controls --------------------------------------------------------
export const windowIsMaximized = (): Promise<boolean> => invoke('windowIsMaximized')
export const windowMinimize = (): Promise<void> => invoke('windowMinimize')
export const windowMaximize = (): Promise<void> => invoke('windowMaximize')
export const windowClose = (): Promise<void> => invoke('windowClose')
