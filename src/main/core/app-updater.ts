import { existsSync, mkdirSync, writeFileSync, unlinkSync } from 'fs'
import { spawn, spawnSync } from 'child_process'
import { randomUUID } from 'crypto'
import path from 'path'
import { app } from 'electron'
import { dataDir, isPortable } from '../utils/dirs'
import { getAppConfig, patchAppConfig } from '../config'
import type { PersistedUpdateCache, UpdateCacheMetadata } from '../utils/update-cache'
import { loadUpdateCache, saveUpdateCache } from '../utils/update-cache'
import { devEnv } from '../utils/dev-env'
import {
  REQUEST_HEADERS,
  fetchGithubApi,
  fetchReleaseAsset,
  fetchReleaseByTag,
  resolveReleaseDigest,
  selectReleaseAsset,
  type GhAsset,
  type GhRelease
} from '../utils/github'
import { assertExpectedReleaseTag, verifyAsset } from './update-integrity'
import { getZapretStatus, startZapret, stopZapret } from './zapret'
import { stopTgws } from './tgws'

const DEFAULT_REPO = 'slavniynazzik/SkipNet'
const INSTALLER_ASSET_PATTERNS = [/^SkipNet_x64\.exe$/i] as const
const MIN_INSTALLER_BYTES = 5 * 1024 * 1024

// Test/seam override for the repository name only (still api.github.com).
// Ignored outside development by `devEnv`.
function updateRepo(): string {
  const override = devEnv('SKIPNET_UPDATE_REPO')
  return (override || DEFAULT_REPO).replace(/^\/+|\/+$/g, '')
}

function releasesLatestPath(): string {
  return `/repos/${updateRepo()}/releases/latest`
}

export const UPGRADE_MARKER_NAME = '.skipnet-upgrade'

// One-shot flag in userData: "Zapret was running when the user installed an
// update". The updater has to stop winws.exe before NSIS can replace the
// install folder (otherwise a locked .exe aborts the in-place upgrade), so the
// new instance reads this flag on startup and turns the bypass back on.
const RESUME_ZAPRET_MARKER = 'resume-zapret-after-update'

export function markResumeZapretAfterUpdate(): void {
  try {
    mkdirSync(dataDir(), { recursive: true })
    writeFileSync(path.join(dataDir(), RESUME_ZAPRET_MARKER), `${Date.now()}\n`, 'utf8')
  } catch {
    /* best-effort: the update itself must not be blocked */
  }
}

/** Returns true once if the previous instance asked to restore Zapret. */
export function consumeResumeZapretAfterUpdate(): boolean {
  const file = path.join(dataDir(), RESUME_ZAPRET_MARKER)
  try {
    if (!existsSync(file)) return false
    unlinkSync(file)
    return true
  } catch {
    return false
  }
}

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

function parseVersion(s?: string): string | null {
  if (!s) return null
  const stripped = s.replace(/^v/i, '').trim()
  if (!/^\d+(\.\d+)+/.test(stripped)) return null
  const m = stripped.match(/^\d+(\.\d+)+([.\-+][\w.\-+]+)?/)
  return m ? m[0] : null
}

function compareVersion(a: string, b: string): number {
  const norm = (v: string): (number | string)[] =>
    v
      .replace(/^v/i, '')
      .split(/[.\-+]/)
      .map((p) => (/^\d+$/.test(p) ? parseInt(p, 10) : p))
  const aa = norm(a)
  const bb = norm(b)
  const len = Math.max(aa.length, bb.length)
  for (let i = 0; i < len; i++) {
    const av = aa[i] ?? 0
    const bv = bb[i] ?? 0
    if (typeof av === 'number' && typeof bv === 'number') {
      if (av > bv) return 1
      if (av < bv) return -1
    } else {
      const as = String(av)
      const bs = String(bv)
      if (as > bs) return 1
      if (as < bs) return -1
    }
  }
  return 0
}

let cache: PersistedUpdateCache | null = null
let cacheHydrated = false
const CACHE_TTL_MS = 6 * 60 * 60 * 1000
const CACHE_NAME = 'app'

function hydrateCacheFromDisk(): void {
  if (cacheHydrated) return
  cacheHydrated = true
  const persisted = loadUpdateCache(CACHE_NAME)
  if (persisted) cache = persisted
}

let refreshInflight = false
function backgroundRefresh(): void {
  if (refreshInflight) return
  refreshInflight = true
  checkAppUpdate(true)
    .catch(() => void 0)
    .finally(() => {
      refreshInflight = false
    })
}

export async function checkAppUpdate(force = false): Promise<AppUpdateInfo> {
  hydrateCacheFromDisk()
  const installed = app.getVersion()
  const cfg = await getAppConfig()
  const dismissedTag = cfg.dismissedAppUpdateTag

  if (
    !force &&
    cache &&
    Date.now() - cache.at < CACHE_TTL_MS &&
    cache.data.tag &&
    cache.data.version
  ) {
    if (Date.now() - cache.at > 30 * 60 * 1000) backgroundRefresh()
    const cachedLatest = cache.data.version
    return {
      installed,
      latest: cachedLatest,
      hasUpdate: !!cachedLatest && compareVersion(cachedLatest, installed) > 0,
      tag: cache.data.tag,
      releaseNotes: cache.data.releaseNotes,
      publishedAt: cache.data.publishedAt,
      dismissed: dismissedTag === cache.data.tag
    }
  }

  let release: GhRelease
  try {
    const res = await fetchGithubApi(releasesLatestPath(), {
      headers: REQUEST_HEADERS,
      timeoutMs: 10_000
    })
    if (!res.ok) throw new Error(`GitHub API ${res.status}`)
    release = (await res.json()) as GhRelease
  } catch (e) {
    throw new Error(
      `Не удалось проверить обновления SkipNet: ${e instanceof Error ? e.message : String(e)}`
    )
  }

  const installedInfo = (latest?: string, tag?: string): AppUpdateInfo => ({
    installed,
    latest,
    hasUpdate: !!latest && compareVersion(latest, installed) > 0,
    tag,
    releaseUrl: release.html_url,
    releaseNotes: release.body?.trim() || undefined,
    publishedAt: release.published_at,
    dismissed: !!tag && dismissedTag === tag
  })

  if (release.draft || release.prerelease) {
    const info: AppUpdateInfo = { installed, hasUpdate: false }
    cache = { at: Date.now(), data: {} }
    return info
  }

  const tag = release.tag_name?.trim() || undefined
  const latest = parseVersion(tag) || parseVersion(release.name) || undefined
  const info = installedInfo(latest, tag)

  // Persist display metadata only. Asset URL/digest/size are resolved from
  // the API again at install time (see `installAppUpdate`).
  const metadata: UpdateCacheMetadata = {
    tag: info.tag,
    version: info.latest,
    hasUpdate: info.hasUpdate,
    publishedAt: info.publishedAt,
    releaseNotes: info.releaseNotes
  }
  cache = { at: Date.now(), data: metadata }
  saveUpdateCache(CACHE_NAME, metadata)
  return info
}

export async function dismissAppUpdate(tag: string): Promise<void> {
  if (!tag) return
  await patchAppConfig({ dismissedAppUpdateTag: tag })
}

// Path of the upgrade marker, written next to SkipNet.exe so the OLD
// installer's customUnInstall macro can find it via $INSTDIR.
function upgradeMarkerPath(name = UPGRADE_MARKER_NAME): string {
  // app.getAppPath() points at .../resources/app.asar in prod and at the
  // repo root in dev — neither is $INSTDIR. The exe lives one level up
  // from the resources folder, which `process.execPath` references.
  const exeDir = path.dirname(process.execPath)
  return path.join(exeDir, name)
}

function writeUpgradeMarker(): void {
  const dir = path.dirname(process.execPath)
  try {
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true })
    // Write the new marker plus the pre-rebrand one: the first upgrade runs
    // the OLD installer's uninstaller, which only knows `.slipgate-upgrade`.
    for (const name of [UPGRADE_MARKER_NAME, '.slipgate-upgrade']) {
      try {
        writeFileSync(upgradeMarkerPath(name), `skipnet-upgrade ${Date.now()}\n`, 'utf8')
      } catch {
        /* one marker is enough to protect user data */
      }
    }
  } catch (e) {
    console.warn('[app-updater] write upgrade marker failed:', e)
  }
}

/**
 * Install the release the main process last checked.
 *
 * The renderer supplies only a tag. Everything that decides *what* runs —
 * repository, release, asset name, size, digest and download URL — is resolved
 * from `api.github.com` here, at install time. The persisted update cache is
 * used for exactly one thing: confirming the tag matches the release that was
 * last checked and shown to the user.
 *
 * The installer is launched in silent mode and SkipNet quits so NSIS can
 * replace the on-disk files. The installer auto-relaunches the new SkipNet when
 * it's done; the user perceives the upgrade as ~5–10 s of "closed and reopened".
 */
export async function installAppUpdate(tag: string): Promise<{ scheduled: true }> {
  if (process.platform !== 'win32') {
    throw new Error('Авто-обновление поддерживается только на Windows')
  }
  if (isPortable()) {
    // The portable build has no NSIS uninstaller/registry entry. Running the
    // installer would create a second, independent installation in Program
    // Files while the portable copy stays stale. Point the user at the
    // portable archive instead.
    throw new Error(
      'Портативную версию нельзя обновить автоматически. Скачайте новый ' +
        'SkipNet_x64-portable.7z со страницы релиза и распакуйте поверх текущей папки.'
    )
  }

  hydrateCacheFromDisk()
  const releaseTag = assertExpectedReleaseTag(tag, cache?.data.tag)

  const release = await fetchReleaseByTag(updateRepo(), releaseTag)
  if (!release) {
    throw new Error(`Релиз ${releaseTag} не найден на GitHub — установка отменена`)
  }
  const asset: GhAsset = selectReleaseAsset(
    release,
    INSTALLER_ASSET_PATTERNS,
    'установщик SkipNet_x64.exe'
  )
  const expectedVersion = parseVersion(releaseTag) ?? parseVersion(release.name) ?? undefined
  if (!expectedVersion || compareVersion(expectedVersion, app.getVersion()) <= 0) {
    // Defence in depth: a tampered cache could name an older (but genuine)
    // release. Never downgrade via the updater.
    throw new Error('Запрошенный релиз не новее установленной версии — установка отменена')
  }
  const expectedDigest = await resolveReleaseDigest(release, asset, 'установщика SkipNet')

  let buf: Buffer
  try {
    const res = await fetchReleaseAsset(asset.browser_download_url, {
      headers: { 'User-Agent': REQUEST_HEADERS['User-Agent'] },
      timeoutMs: 600_000
    })
    if (!res.ok) throw new Error(`HTTP ${res.status}`)
    const ab = await res.arrayBuffer()
    buf = Buffer.from(ab)
  } catch (e) {
    throw new Error(
      `Не удалось скачать установщик: ${e instanceof Error ? e.message : String(e)}`
    )
  }

  // A real SkipNet installer is ~100 MB. The 5 MB floor protects against a
  // proxy/error page even if the release metadata is somehow wrong. The
  // bypass is dev-only (`devEnv` returns undefined in packaged builds).
  const allowSmall = devEnv('SKIPNET_UPDATE_ALLOW_SMALL') === '1'
  verifyAsset(buf, {
    digest: expectedDigest,
    size: asset.size,
    minBytes: allowSmall ? 0 : MIN_INSTALLER_BYTES,
    label: 'установщика SkipNet'
  })

  if (!(buf[0] === 0x4d && buf[1] === 0x5a)) {
    throw new Error('Загруженный файл не является исполняемым файлом Windows (нет заголовка MZ)')
  }

  // Write the installer to %TEMP% so it's auto-cleaned by Windows. Using
  // a stable name plus a timestamp keeps concurrent retries (rare) from
  // colliding while leaving older copies for Disk Cleanup to remove.
  const dir = app.getPath('temp')
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true })
  const installerPath = path.join(dir, `SkipNet-update-${randomUUID()}.exe`)
  writeFileSync(installerPath, buf, { flag: 'wx' })

  // Tell the OLD installer's customUnInstall macro that this run is an
  // in-place upgrade and the user-data wipe MUST be skipped — otherwise
  // %APPDATA%\skipnet (every config the user has) would vanish.
  writeUpgradeMarker()

  if (expectedVersion) {
    try {
      await patchAppConfig({ dismissedAppUpdateTag: undefined })
    } catch {
      /* noop — user can dismiss manually if cleanup fails */
    }
  }

  // NSIS replaces the whole install directory during an in-place upgrade and
  // aborts if any file inside it is still in use. winws.exe runs from
  // `<install>\resources\zapret\bin`, so leaving Zapret on made the upgrade
  // fail silently (the app quit, nothing was installed and nothing came
  // back). Stop both helpers before the installer starts; remember that
  // Zapret was on so the new instance can restore it.
  try {
    const state = getZapretStatus().state
    if (state === 'running' || state === 'starting') {
      markResumeZapretAfterUpdate()
    }
  } catch {
    /* best-effort */
  }
  await Promise.all([stopZapret().catch(() => void 0), stopTgws().catch(() => void 0)])
  // Belt and braces: kill anything still holding the bundle open.
  for (const image of ['winws.exe', 'TgWsProxy_windows.exe']) {
    try {
      spawnSync('taskkill.exe', ['/F', '/IM', image, '/T'], {
        windowsHide: true,
        timeout: 5000
      })
    } catch {
      /* noop */
    }
  }

  // Spawn detached so the installer survives our app.quit(). Wait for the
  // actual spawn outcome before shutting down: if the installer cannot be
  // started (AV block, deleted file, EACCES) the app used to quit anyway,
  // leaving nothing installing and nothing running.
  //
  // `--force-run` is what makes the assisted installer start SkipNet again
  // after a *silent* (/S) update: without it electron-builder only relaunches
  // from the finish page, which never appears in silent mode.
  const child = spawn(installerPath, ['/S', '--updated', '--force-run'], {
    detached: true,
    stdio: 'ignore',
    windowsHide: true
  })

  let installerPid: number | undefined
  try {
    await new Promise<void>((resolve, reject) => {
      child.once('spawn', () => resolve())
      child.once('error', (e) => reject(e))
    })
    installerPid = child.pid
  } catch (e) {
    try {
      unlinkSync(installerPath)
    } catch {
      /* noop — temp file, Windows will clean it eventually */
    }
    // The installer never started, so the app will keep running. Drop the
    // one-shot "restore Zapret" flag and turn Zapret back on if we stopped it.
    if (consumeResumeZapretAfterUpdate()) {
      startZapret().catch(() => void 0)
    }
    throw new Error(
      `Не удалось запустить установщик: ${e instanceof Error ? e.message : String(e)}`
    )
  }
  child.on('error', (e) => console.error('[app-updater] installer error:', e))
  child.unref()

  // Re-launch watcher. `--force-run` lets the installer start SkipNet after a
  // silent update, but NSIS can still abort (AV lock, user policy, aborted
  // upgrade). This second, independent watcher makes sure the app comes back
  // either way: wait for the installer, give the installer's own launch a
  // moment, then start SkipNet only if no instance is running, retrying a few
  // times so a slow Defender scan cannot swallow the launch.
  if (installerPid) {
    try {
      const exePath = process.execPath
      const exeDir = path.dirname(exePath)
      const ts = randomUUID()
      const logPath = path.join(dir, `SkipNet-relaunch-${ts}.log`)
      const watcherScript = [
        "$ErrorActionPreference = 'SilentlyContinue'",
        `$installerPid = ${installerPid}`,
        `$exe = '${exePath.replace(/'/g, "''")}'`,
        `$exeDir = '${exeDir.replace(/'/g, "''")}'`,
        `$logPath = '${logPath.replace(/'/g, "''")}'`,
        'function Log($m) {',
        "  try { Add-Content -LiteralPath $logPath -Value \"$([DateTime]::Now.ToString('HH:mm:ss.fff')) $m\" } catch {}",
        '}',
        'function AppRunning() {',
        '  return [bool](Get-Process -Name SkipNet -ErrorAction SilentlyContinue)',
        '}',
        'Log "watcher started, installerPid=$installerPid exe=$exe"',
        // 1) Wait for the installer to finish (up to 10 min — silent NSIS
        //    upgrades take 5–15s but slow disks / AV may stretch it).
        '$deadline = (Get-Date).AddMinutes(10)',
        'while ((Get-Date) -lt $deadline) {',
        '  if (-not (Get-Process -Id $installerPid -ErrorAction SilentlyContinue)) { Log "installer exited"; break }',
        '  Start-Sleep -Milliseconds 500',
        '}',
        // 2) Defender often holds the freshly-written SkipNet.exe for a few
        //    seconds for an on-write scan; give the installer's own relaunch
        //    (--force-run) time to happen before we interfere.
        'Start-Sleep -Seconds 5',
        'if (AppRunning) { Log "app already running — watcher done"; exit 0 }',
        // 3) Wait until the new exe actually exists on disk.
        '$filePoll = (Get-Date).AddSeconds(90)',
        'while ((Get-Date) -lt $filePoll -and -not (Test-Path -LiteralPath $exe)) {',
        '  Start-Sleep -Milliseconds 500',
        '}',
        'if (-not (Test-Path -LiteralPath $exe)) { Log "exe missing at $exe — giving up"; exit 1 }',
        // 4) Launch, then verify it stayed alive. A process that appears and
        //    disappears is usually the single-instance lock rejecting a
        //    duplicate while the installer's own copy is starting — retry.
        'for ($i = 1; $i -le 6; $i++) {',
        '  if (AppRunning) { Log "app is running (attempt $i)"; exit 0 }',
        '  try {',
        '    Start-Process -FilePath $exe -WorkingDirectory $exeDir',
        '    Log "Start-Process OK (attempt $i)"',
        '  } catch {',
        '    Log "Start-Process failed: $_ — trying .NET fallback"',
        '    try {',
        '      [System.Diagnostics.Process]::Start($exe) | Out-Null',
        '      Log "Process.Start OK (attempt $i)"',
        '    } catch {',
        '      Log "launch failed (attempt $i): $_"',
        '    }',
        '  }',
        '  Start-Sleep -Seconds 5',
        '  if (AppRunning) { Log "relaunch confirmed (attempt $i)"; exit 0 }',
        '  Log "app not running after attempt $i"',
        '}',
        'Log "all relaunch attempts failed"',
        'exit 1'
      ].join('\n')
      const watcherPath = path.join(dir, `SkipNet-relaunch-${ts}.ps1`)
      // Prepend BOM so PowerShell reads the script as UTF-8 even on
      // legacy systems where the OEM code page would otherwise mangle
      // non-ASCII characters in install paths.
      writeFileSync(watcherPath, '\ufeff' + watcherScript, {
        encoding: 'utf8',
        flag: 'wx'
      })
      const watcher = spawn(
        'powershell.exe',
        [
          '-NoProfile',
          '-WindowStyle',
          'Hidden',
          '-ExecutionPolicy',
          'Bypass',
          '-File',
          watcherPath
        ],
        {
          detached: true,
          stdio: 'ignore',
          windowsHide: true
        }
      )
      watcher.on('error', (e) =>
        console.error('[app-updater] relaunch watcher spawn error:', e)
      )
      watcher.unref()
    } catch (e) {
      // Watcher is best-effort — if it fails the user just has to
      // double-click the desktop shortcut after install. Don't block
      // the upgrade itself on this.
      console.warn('[app-updater] relaunch watcher setup failed:', e)
    }
  }

  // Give NSIS a beat to acquire the install lock, then quit. If we quit
  // synchronously the installer's "is target running?" probe sometimes
  // races and shows a "close SkipNet" prompt despite /S.
  setTimeout(() => {
    try {
      app.quit()
    } catch {
      /* falling through to process.exit below */
    }
    setTimeout(() => process.exit(0), 1000)
  }, 800)

  return { scheduled: true }
}

// Convenience used by index.ts on startup if autoCheckUpdate is enabled.
export function silentBackgroundCheck(): void {
  checkAppUpdate(false).catch(() => void 0)
}

// Re-export so unrelated modules don't have to depend on the cache
// internals when they want to hint that a fresh check is appropriate
// (e.g. after the user explicitly cleared `dismissedAppUpdateTag`).
export function invalidateAppUpdateCache(): void {
  cache = null
}
