import { installZapretArchive, getZapretStatus, listStrategies, startZapret } from './zapret'
import { getAppConfig, patchAppConfig } from '../config'
import type { PersistedUpdateCache, UpdateCacheMetadata } from '../utils/update-cache'
import { loadUpdateCache, saveUpdateCache } from '../utils/update-cache'
import {
  REQUEST_HEADERS,
  fetchGithubApi,
  fetchReleaseAsset,
  fetchReleaseByTag,
  resolveReleaseDigest,
  selectReleaseAsset,
  type GhRelease
} from '../utils/github'
import { assertExpectedReleaseTag, verifyAsset } from './update-integrity'
import { compareVersion } from '../../shared/version'

const REPO = 'Flowseal/zapret-discord-youtube'
const RELEASES_LATEST_PATH = `/repos/${REPO}/releases/latest`
// Exact-name allow-list. Anything else in the release (README, sources,
// checksums) is never treated as the bundle.
const ZIP_ASSET_PATTERNS = [/^zapret-discord-youtube[\w.+-]*\.zip$/i, /^zapret[\w.+-]*\.zip$/i] as const
const MIN_ZIP_BYTES = 1024 * 1024

export interface ZapretUpdateInfo {
  installed?: string
  latest?: string
  /** Raw GitHub tag (`v1.7.7` or `1.7.7`); the only thing the renderer sends back. */
  tag?: string
  hasUpdate: boolean
  assetName?: string
  releaseUrl?: string
  publishedAt?: string
  // True when the current `latest` tag matches the one the user previously
  // dismissed via "Later". UI uses this to keep the banner hidden until
  // upstream ships a fresher tag.
  dismissed?: boolean
}

// 12-hour cache, persisted to disk via the update-cache helper so the next
// launch can render the banner instantly instead of waiting for GitHub.
let cache: PersistedUpdateCache | null = null
let cacheHydrated = false
const CACHE_TTL_MS = 12 * 60 * 60 * 1000
const CACHE_NAME = 'zapret'

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
  checkZapretUpdate(true)
    .catch(() => void 0)
    .finally(() => {
      refreshInflight = false
    })
}

const BUNDLED_ZAPRET_VERSION = '1.10.4'

function effectiveInstalled(cfgInstalled?: string): string {
  return cfgInstalled && cfgInstalled.trim() ? cfgInstalled.trim() : BUNDLED_ZAPRET_VERSION
}

export async function checkZapretUpdate(force = false): Promise<ZapretUpdateInfo> {
  hydrateCacheFromDisk()
  if (!force && cache && Date.now() - cache.at < CACHE_TTL_MS && cache.data.version) {
    // Re-attach live values that may have changed since the cached call.
    const cfg = await getAppConfig()
    const installedNow = effectiveInstalled(cfg.zapret?.installedVersion)
    if (Date.now() - cache.at > 60 * 60 * 1000) backgroundRefresh()
    return {
      installed: installedNow,
      latest: cache.data.version,
      tag: cache.data.tag,
      hasUpdate:
        !!cache.data.version && compareVersion(cache.data.version, installedNow) > 0,
      publishedAt: cache.data.publishedAt,
      dismissed: cfg.zapret?.dismissedUpdateTag === cache.data.version
    }
  }

  const cfg = await getAppConfig()
  const installed = effectiveInstalled(cfg.zapret?.installedVersion)
  const dismissedTag = cfg.zapret?.dismissedUpdateTag

  let release: GhRelease
  try {
    const res = await fetchGithubApi(RELEASES_LATEST_PATH, {
      headers: REQUEST_HEADERS,
      timeoutMs: 10_000
    })
    if (!res.ok) throw new Error(`GitHub API ${res.status}`)
    release = (await res.json()) as GhRelease
  } catch (e) {
    // Network/rate-limit failures are non-fatal — UI just stays quiet.
    throw new Error(`Не удалось проверить обновления: ${e instanceof Error ? e.message : String(e)}`)
  }

  const tag = release.tag_name?.trim() || release.name?.trim() || undefined
  const latest = tag?.replace(/^v/i, '').trim() || undefined

  const assets = release.assets ?? []
  const zipAsset =
    assets.find((a) => /^zapret-discord-youtube[\w.+-]*\.zip$/i.test(a.name)) ??
    assets.find((a) => /^zapret[\w.+-]*\.zip$/i.test(a.name))

  const hasUpdate = !!latest && compareVersion(latest, installed) > 0

  const info: ZapretUpdateInfo = {
    installed,
    latest,
    tag,
    hasUpdate,
    assetName: zipAsset?.name,
    releaseUrl: release.html_url,
    publishedAt: release.published_at,
    dismissed: !!latest && dismissedTag === latest
  }

  // Persist display metadata only; the archive URL/digest/size are resolved
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

/**
 * Install the Zapret release the main process last checked.
 *
 * The renderer supplies only a tag. Repository, asset name, byte size, digest
 * and download URL are resolved from `api.github.com` here, at install time;
 * the on-disk cache cannot change any of them. No archive is extracted without
 * a verified sha256.
 */
export async function installZapretUpdate(
  tag: string
): Promise<{ strategies: number; installedVersion?: string }> {
  hydrateCacheFromDisk()
  const releaseTag = assertExpectedReleaseTag(tag, cache?.data.tag)

  const release = await fetchReleaseByTag(REPO, releaseTag)
  if (!release) {
    throw new Error(`Релиз ${releaseTag} не найден на GitHub — установка отменена`)
  }
  const asset = selectReleaseAsset(release, ZIP_ASSET_PATTERNS, 'архив Zapret')
  const expectedVersion = releaseTag.replace(/^v/i, '').trim() || undefined
  const installedNow = effectiveInstalled((await getAppConfig()).zapret?.installedVersion)
  if (!expectedVersion || compareVersion(expectedVersion, installedNow) <= 0) {
    throw new Error('Запрошенный релиз не новее установленной версии — установка отменена')
  }
  const expectedDigest = await resolveReleaseDigest(release, asset, 'архива Zapret')

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
    throw new Error(`Не удалось скачать архив: ${e instanceof Error ? e.message : String(e)}`)
  }

  verifyAsset(buf, {
    digest: expectedDigest,
    size: asset.size,
    minBytes: MIN_ZIP_BYTES,
    label: 'архива Zapret'
  })

  // `installZapretArchive` must stop winws.exe to replace the files. Remember
  // whether bypassing was active so we can bring it back afterwards instead of
  // silently leaving the user without a working bypass after an update.
  const previous = getZapretStatus().state
  const wasRunning = previous === 'running' || previous === 'starting'

  const result = await installZapretArchive(new Uint8Array(buf))

  const finalVersion = result.installedVersion ?? expectedVersion ?? undefined
  const cfg = await getAppConfig()
  const next: ZapretConfig = {
    ...(cfg.zapret as ZapretConfig),
    installedVersion: finalVersion ?? cfg.zapret?.installedVersion,
    dismissedUpdateTag: undefined
  }
  await patchAppConfig({ zapret: next })

  if (wasRunning) {
    // The selected strategy may not exist in the new bundle (upstream renames
    // them), in which case starting would only produce an error — leave it
    // stopped and let the user pick a fresh one.
    const active = next.activeStrategy
    const stillAvailable = !!active && listStrategies().some((s) => s.file === active)
    if (stillAvailable) {
      try {
        await startZapret()
      } catch {
        /* surfaced through the Zapret status card */
      }
    }
  }

  // Invalidate cache so a follow-up check reflects "up to date".
  cache = null
  // Surface the persisted version in the result so the renderer can reflect
  // the new state without an extra round-trip.
  return { strategies: result.strategies, installedVersion: finalVersion }
}

export async function dismissZapretUpdate(tag: string): Promise<void> {
  if (!tag) return
  const cfg = await getAppConfig()
  const next: ZapretConfig = {
    ...(cfg.zapret as ZapretConfig),
    dismissedUpdateTag: tag
  }
  await patchAppConfig({ zapret: next })
}
