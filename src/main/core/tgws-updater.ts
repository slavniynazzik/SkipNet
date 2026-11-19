import { existsSync, mkdirSync, renameSync, rmSync, unlinkSync, writeFileSync } from 'fs'
import path from 'path'
import { randomUUID } from 'crypto'
import { tgwsBinaryPath } from '../utils/dirs'
import { getAppConfig, patchAppConfig } from '../config'
import {
  readManifestOrNull,
  updateManifestEntries,
  verifyTgwsBinary,
  writeManifestEntries
} from './binary-integrity'
import type { PersistedUpdateCache, UpdateCacheMetadata } from '../utils/update-cache'
import { loadUpdateCache, saveUpdateCache } from '../utils/update-cache'
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
import { stopTgws, getTgwsStatus } from './tgws'
import { killOwnedComponent } from './process-kill'

// Primary: SkipNet-owned CLI build. Fallback: the known-good headless CLI
// mirror used before the rebrand, so component updates keep working until the
// new repository publishes its first release.
const REPOS = [
  'slavniynazzik/SkipNet-tgws-cli',
  'tenstepsbeforedecay/slipgate-tgws-cli'
] as const

// Exact-name allow-list for the 64-bit Windows CLI. The release also ships a
// Win-7 32-bit build we must not install on modern systems.
const BINARY_ASSET_PATTERNS = [
  /^TgWsProxy_windows\.exe$/i,
  /^tgws[\w.+-]*\.exe$/i,
  /^TgWsProxy_windows(?!.*32bit)[\w.+-]*\.exe$/i
] as const
const MIN_BINARY_BYTES = 1024 * 1024

const BUNDLED_TGWS_VERSION = '1.11.4'

export interface TgwsUpdateInfo {
  installed?: string
  latest?: string
  /** Raw GitHub tag (`v1.11.4` or `1.11.4`); the only thing the renderer sends back. */
  tag?: string
  hasUpdate: boolean
  assetName?: string
  releaseUrl?: string
  publishedAt?: string
  dismissed?: boolean
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
const CACHE_TTL_MS = 12 * 60 * 60 * 1000
const CACHE_NAME = 'tgws'

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
  checkTgwsUpdate(true)
    .catch(() => void 0)
    .finally(() => {
      refreshInflight = false
    })
}

// Effective installed version: explicit config value > bundled-build constant.
function effectiveInstalled(cfgInstalled?: string): string {
  return cfgInstalled && cfgInstalled.trim() ? cfgInstalled.trim() : BUNDLED_TGWS_VERSION
}

async function fetchLatestRelease(): Promise<GhRelease> {
  let lastError: unknown = null
  for (const repo of REPOS) {
    try {
      const res = await fetchGithubApi(`/repos/${repo}/releases/latest`, {
        headers: REQUEST_HEADERS,
        timeoutMs: 10_000
      })
      if (!res.ok) {
        // A missing repo (404) must fall through to the next candidate.
        lastError = new Error(`GitHub API ${res.status}`)
        continue
      }
      return (await res.json()) as GhRelease
    } catch (e) {
      lastError = e
    }
  }
  throw lastError instanceof Error ? lastError : new Error('GitHub API недоступен')
}

export async function checkTgwsUpdate(force = false): Promise<TgwsUpdateInfo> {
  hydrateCacheFromDisk()
  const cfg = await getAppConfig()
  const installed = effectiveInstalled(cfg.tgws?.installedVersion)
  const dismissedTag = cfg.tgws?.dismissedUpdateTag

  if (!force && cache && Date.now() - cache.at < CACHE_TTL_MS && cache.data.version) {
    // Cache is fresh — return it. If it's older than 1h schedule a silent
    // background refresh so the user gets up-to-date info on the NEXT
    // launch without paying the GitHub latency on this one.
    if (Date.now() - cache.at > 60 * 60 * 1000) backgroundRefresh()
    return {
      installed,
      latest: cache.data.version,
      tag: cache.data.tag,
      hasUpdate: !!cache.data.version && compareVersion(cache.data.version, installed) > 0,
      publishedAt: cache.data.publishedAt,
      dismissed: dismissedTag === cache.data.version
    }
  }

  let release: GhRelease
  try {
    release = await fetchLatestRelease()
  } catch (e) {
    throw new Error(
      `Не удалось проверить обновления TgWsProxy: ${e instanceof Error ? e.message : String(e)}`
    )
  }

  const tag = release.tag_name?.trim() || release.name?.trim() || undefined
  const latest = tag?.replace(/^v/i, '').trim() || undefined

  const assets = release.assets ?? []
  const winAsset = assets.find(
    (a) =>
      /^TgWsProxy_windows\.exe$/i.test(a.name) ||
      /^tgws[\w.+-]*\.exe$/i.test(a.name) ||
      /^TgWsProxy_windows(?!.*32bit)[\w.+-]*\.exe$/i.test(a.name)
  )

  const hasUpdate = !!latest && compareVersion(latest, installed) > 0

  const info: TgwsUpdateInfo = {
    installed,
    latest,
    tag,
    hasUpdate,
    assetName: winAsset?.name,
    releaseUrl: release.html_url,
    publishedAt: release.published_at,
    dismissed: !!latest && dismissedTag === latest
  }

  // Persist display metadata only; the binary URL/digest/size are resolved
  // from the API again at install time.
  const metadata: UpdateCacheMetadata = {
    tag: info.tag,
    version: info.latest,
    hasUpdate: info.hasUpdate,
    publishedAt: info.publishedAt
  }
  cache = { at: Date.now(), data: metadata }
  saveUpdateCache(CACHE_NAME, metadata)
  return info
}

// Best-effort stop of our own TgWsProxy so we can overwrite the binary on
// Windows (where a running .exe holds an exclusive write lock). C7: only the
// tracked PID or a binary inside our resources tree — never `/IM`.
async function killStaleTgwsBinary(): Promise<void> {
  if (process.platform !== 'win32') return
  try {
    await killOwnedComponent('tgws', ['TgWsProxy_windows.exe'])
  } catch {
    /* best-effort — the write below will surface a hard lock */
  }
  // Give the OS a beat to release the file lock.
  await new Promise((r) => setTimeout(r, 300))
}

/**
 * Resolve the release + binary for a tag by querying `api.github.com` at
 * install time. The tag may have come from either candidate repository, so
 * both are tried; the on-disk cache never records which one it was.
 */
async function resolveInstallTarget(
  releaseTag: string
): Promise<{ release: GhRelease; asset: GhAsset }> {
  let lastError: unknown = null
  for (const repo of REPOS) {
    let release: GhRelease | null
    try {
      release = await fetchReleaseByTag(repo, releaseTag)
    } catch (e) {
      lastError = e
      continue
    }
    if (!release) continue
    try {
      const asset = selectReleaseAsset(
        release,
        BINARY_ASSET_PATTERNS,
        'TgWsProxy_windows.exe'
      )
      return { release, asset }
    } catch (e) {
      lastError = e
    }
  }
  if (lastError instanceof Error) throw lastError
  throw new Error(`Релиз ${releaseTag} не найден на GitHub — установка отменена`)
}

/**
 * Install the TgWsProxy build the main process last checked.
 *
 * The renderer supplies only a tag; repo, asset, size, digest and URL are
 * resolved from `api.github.com` at install time. No executable is written
 * without a verified sha256.
 */
export async function installTgwsUpdate(
  tag: string
): Promise<{ installedVersion?: string; sizeBytes: number }> {
  hydrateCacheFromDisk()
  const releaseTag = assertExpectedReleaseTag(tag, cache?.data.tag)

  const { release, asset } = await resolveInstallTarget(releaseTag)
  const expectedVersion = releaseTag.replace(/^v/i, '').trim() || undefined
  const installedNow = effectiveInstalled((await getAppConfig()).tgws?.installedVersion)
  if (!expectedVersion || compareVersion(expectedVersion, installedNow) <= 0) {
    throw new Error('Запрошенный релиз не новее установленной версии — установка отменена')
  }
  const expectedDigest = await resolveReleaseDigest(release, asset, 'TgWsProxy')

  let buf: Buffer
  try {
    const res = await fetchReleaseAsset(asset.browser_download_url, {
      headers: { 'User-Agent': REQUEST_HEADERS['User-Agent'] },
      timeoutMs: 300_000
    })
    if (!res.ok) throw new Error(`HTTP ${res.status}`)
    const ab = await res.arrayBuffer()
    buf = Buffer.from(ab)
  } catch (e) {
    throw new Error(`Не удалось скачать TgWsProxy: ${e instanceof Error ? e.message : String(e)}`)
  }

  verifyAsset(buf, {
    digest: expectedDigest,
    size: asset.size,
    minBytes: MIN_BINARY_BYTES,
    label: 'TgWsProxy'
  })

  if (!(buf[0] === 0x4d && buf[1] === 0x5a)) {
    throw new Error('Загруженный файл не является исполняемым файлом Windows (нет заголовка MZ)')
  }

  // Stop the currently-running tgws first so its on-disk .exe isn't write-
  // locked. Mirrors the zapret install flow.
  const st = getTgwsStatus()
  if (st.state === 'running' || st.state === 'starting') {
    try { await stopTgws() } catch { /* best-effort */ }
  }
  // Even after our managed stop there can be a stray TgWsProxy_windows.exe
  // (manual user launch, prior crash) — wipe everything matching the image
  // name before writing.
  await killStaleTgwsBinary()

  const dest = tgwsBinaryPath()
  const dir = path.dirname(dest)
  const resourcesRoot = path.dirname(dir)
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true })
  const relativePath = `${path.basename(dir)}/${path.basename(dest)}`

  // Write to a staging file first so a failed write cannot truncate the
  // working binary that is currently on disk. The old binary is moved aside
  // (not deleted) until the manifest has been updated and verified.
  const previousManifest = readManifestOrNull(resourcesRoot)
  const tmp = `${dest}.${randomUUID()}.tmp`
  const backup = `${dest}.${randomUUID()}.previous`
  const hadPrevious = existsSync(dest)
  let swapped = false

  try {
    writeFileSync(tmp, buf, { flag: 'wx' })
    if (hadPrevious) renameSync(dest, backup)
    try {
      renameSync(tmp, dest)
      swapped = true
    } catch (e) {
      if (hadPrevious) {
        try { renameSync(backup, dest) } catch { /* noop */ }
      }
      throw e
    }
    // The payload's sha256 was verified against the release digest above;
    // record the new hash and prove the on-disk bytes match it.
    updateManifestEntries(resourcesRoot, [relativePath])
    verifyTgwsBinary(dest)
  } catch (e) {
    try {
      if (existsSync(tmp)) unlinkSync(tmp)
    } catch {
      /* noop */
    }
    if (swapped) {
      try { rmSync(dest, { force: true }) } catch { /* noop */ }
      if (hadPrevious) {
        try { renameSync(backup, dest) } catch { /* noop */ }
      }
    }
    if (previousManifest) {
      try { writeManifestEntries(resourcesRoot, previousManifest) } catch { /* noop */ }
    }
    throw new Error(
      `Не удалось установить TgWsProxy: ${e instanceof Error ? e.message : String(e)}`
    )
  }

  if (hadPrevious) {
    try { rmSync(backup, { force: true }) } catch { /* noop */ }
  }

  // Persist version + clear "Later" dismissal.
  const finalVersion = expectedVersion || undefined
  const cfg = await getAppConfig()
  const next: TgwsConfig = {
    ...(cfg.tgws as TgwsConfig),
    installedVersion: finalVersion ?? cfg.tgws?.installedVersion,
    dismissedUpdateTag: undefined
  }
  await patchAppConfig({ tgws: next })

  cache = null
  return { installedVersion: finalVersion, sizeBytes: buf.length }
}

export async function dismissTgwsUpdate(tag: string): Promise<void> {
  if (!tag) return
  const cfg = await getAppConfig()
  const next: TgwsConfig = {
    ...(cfg.tgws as TgwsConfig),
    dismissedUpdateTag: tag
  }
  await patchAppConfig({ tgws: next })
}
