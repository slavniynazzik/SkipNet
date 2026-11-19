/**
 * GitHub helpers, split by trust domain.
 *
 * Release *metadata* (`api.github.com`) is the source of truth for versions,
 * asset names, sizes and digests. It is never proxied through a third-party
 * mirror: a mirror that can rewrite the JSON can also rewrite the digest and
 * hand us a malicious installer.
 *
 * Release *assets* (`github.com/<owner>/<repo>/releases/download/...`) are
 * content-addressed by the digest from that metadata, so proxying the bytes
 * is safe: a mirror can only cause a failed verification, never a silent
 * substitution. Mirrors are tried after the direct URL and only for the exact
 * canonical release-download URL.
 *
 * The legacy `fetchGithub()` export is kept for read-only data refresh
 * (upstream Zapret lists, hosts catalog) and MUST NOT be used for update
 * metadata or executable downloads.
 */
import { parseSha256Digest, parseSha256Sums } from '../core/update-integrity'

const API_ORIGIN = 'https://api.github.com'

const MIRRORS = ['https://gh-proxy.com', 'https://ghfast.top'] as const

/** Canonical GitHub release-download URL, no query string, no credentials. */
const RELEASE_DOWNLOAD_RE =
  /^https:\/\/github\.com\/[A-Za-z0-9][A-Za-z0-9._-]*\/[A-Za-z0-9][A-Za-z0-9._-]*\/releases\/download\/[A-Za-z0-9._~%+-]+\/[A-Za-z0-9._~%+-]+$/

const OBJECTS_HOST = 'objects.githubusercontent.com'

// Legacy mirror allow-list for read-only data. `api.github.com` is
// deliberately absent: metadata must never come from a mirror.
const LEGACY_MIRROR_URL_RE =
  /^https:\/\/(?:github\.com|codeload\.github\.com|raw\.githubusercontent\.com|objects\.githubusercontent\.com)\//i

export const REQUEST_HEADERS: Record<string, string> = {
  'User-Agent': 'SkipNet-Updater',
  Accept: 'application/vnd.github+json'
}

export type GithubUrlKind = 'api' | 'release-asset' | 'asset-redirect' | 'other'

export interface GithubFetchOptions {
  headers?: Record<string, string>
  /** Per-attempt timeout. Downloads should pass a much larger value. */
  timeoutMs?: number
}

export interface GhAsset {
  name: string
  browser_download_url: string
  size: number
  digest?: string | null
}

export interface GhRelease {
  tag_name?: string
  name?: string
  body?: string
  html_url?: string
  published_at?: string
  prerelease?: boolean
  draft?: boolean
  assets?: GhAsset[]
}

/** Classify a URL before it is used for metadata or an asset download. */
export function classifyGithubUrl(raw: string): GithubUrlKind {
  const value = (raw ?? '').trim()
  let parsed: URL
  try {
    parsed = new URL(value)
  } catch {
    return 'other'
  }
  if (parsed.protocol !== 'https:') return 'other'
  if (parsed.username || parsed.password || parsed.port) return 'other'
  if (parsed.origin === API_ORIGIN) return 'api'
  if (parsed.hostname === OBJECTS_HOST) return 'asset-redirect'
  if (RELEASE_DOWNLOAD_RE.test(value)) return 'release-asset'
  return 'other'
}

/**
 * Candidate URLs for a release-asset download.
 *
 * Only the canonical `github.com/<owner>/<repo>/releases/download/<tag>/<file>`
 * URL is mirrored. Everything else — API URLs, `objects.githubusercontent.com`
 * redirect targets, arbitrary hosts — is returned unchanged so the caller
 * fetches exactly what the trusted metadata named and still verifies the
 * digest afterwards.
 */
export function releaseAssetUrlCandidates(url: string): string[] {
  const value = (url ?? '').trim()
  if (classifyGithubUrl(value) !== 'release-asset') return [value]
  return [value, ...MIRRORS.map((mirror) => `${mirror}/${value}`)]
}

/** Build (and validate) an `api.github.com` URL. Never returns a mirror. */
export function githubApiUrl(pathOrUrl: string): string {
  const value = (pathOrUrl ?? '').trim()
  if (!value) throw new Error('Пустой адрес GitHub API')
  if (value.startsWith('/')) {
    if (value.startsWith('//')) throw new Error('Разрешены только запросы к api.github.com')
    return `${API_ORIGIN}${value}`
  }
  let parsed: URL
  try {
    parsed = new URL(value)
  } catch {
    throw new Error('Некорректный адрес GitHub API')
  }
  if (
    parsed.protocol !== 'https:' ||
    parsed.origin !== API_ORIGIN ||
    parsed.username ||
    parsed.password
  ) {
    throw new Error('Разрешены только запросы к api.github.com')
  }
  return parsed.toString()
}

async function fetchOnce(url: string, opts: GithubFetchOptions): Promise<Response> {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), opts.timeoutMs ?? 10_000)
  try {
    return await fetch(url, {
      headers: opts.headers,
      redirect: 'follow',
      signal: controller.signal
    })
  } finally {
    clearTimeout(timer)
  }
}

/**
 * Fetch release metadata. Exactly one candidate: `api.github.com`. No mirrors,
 * no environment overrides.
 */
export async function fetchGithubApi(
  pathOrUrl: string,
  opts: GithubFetchOptions = {}
): Promise<Response> {
  return fetchOnce(githubApiUrl(pathOrUrl), opts)
}

/**
 * Download a release asset. Canonical release-download URLs are retried
 * through the fixed mirror list; any other URL is fetched as-is.
 */
export async function fetchReleaseAsset(
  url: string,
  opts: GithubFetchOptions = {}
): Promise<Response> {
  let lastError: unknown = null
  for (const candidate of releaseAssetUrlCandidates(url)) {
    try {
      const res = await fetchOnce(candidate, opts)
      if (res.ok) return res
      // A definitive 4xx (missing asset) is not fixable by a mirror.
      if (res.status !== 403 && res.status !== 429 && res.status < 500) return res
      lastError = new Error(`GitHub ${res.status}`)
    } catch (e) {
      lastError = e
    }
  }
  const detail = lastError instanceof Error ? lastError.message : String(lastError)
  throw new Error(
    `Не удалось скачать файл с GitHub${detail ? ` (${detail})` : ''}. Проверьте подключение или VPN.`
  )
}

/**
 * @deprecated Read-only data helper (Zapret lists, hosts catalog). Update
 * metadata and executables go through `fetchGithubApi` / `fetchReleaseAsset`.
 */
export async function fetchGithub(url: string, opts: GithubFetchOptions = {}): Promise<Response> {
  const candidates = LEGACY_MIRROR_URL_RE.test(url)
    ? [url, ...MIRRORS.map((mirror) => `${mirror}/${url}`)]
    : [url]
  let lastError: unknown = null

  for (const candidate of candidates) {
    try {
      const res = await fetchOnce(candidate, opts)
      if (res.ok) return res
      // A definitive 4xx (missing release/asset) is not fixable by a mirror.
      if (res.status !== 403 && res.status !== 429 && res.status < 500) return res
      lastError = new Error(`GitHub ${res.status}`)
    } catch (e) {
      lastError = e
    }
  }

  const detail = lastError instanceof Error ? lastError.message : String(lastError)
  throw new Error(
    `GitHub недоступен${detail ? ` (${detail})` : ''}. Проверьте подключение или VPN.`
  )
}

/**
 * Fetch one release by its exact tag. Returns `null` for a genuine 404 so
 * multi-repository updaters can fall through to the next candidate repo.
 */
export async function fetchReleaseByTag(
  repo: string,
  tag: string,
  opts: GithubFetchOptions = {}
): Promise<GhRelease | null> {
  const res = await fetchGithubApi(`/repos/${repo}/releases/tags/${encodeURIComponent(tag)}`, {
    headers: REQUEST_HEADERS,
    timeoutMs: 10_000,
    ...opts
  })
  if (res.status === 404) return null
  if (!res.ok) throw new Error(`GitHub API ${res.status}`)
  return (await res.json()) as GhRelease
}

/**
 * Select a release asset by an exact-name allow-list and require that GitHub
 * reported both a positive size and a download URL.
 */
export function selectReleaseAsset(
  release: GhRelease,
  patterns: readonly RegExp[],
  label: string
): GhAsset {
  const assets = release.assets ?? []
  const asset = assets.find(
    (candidate) =>
      candidate &&
      typeof candidate.name === 'string' &&
      patterns.some((pattern) => pattern.test(candidate.name))
  )
  if (!asset) {
    throw new Error(
      `В релизе ${release.tag_name ?? ''} не найден ${label} — установка отменена`
    )
  }
  if (typeof asset.size !== 'number' || !Number.isFinite(asset.size) || asset.size <= 0) {
    throw new Error(`GitHub не сообщил размер ${label} — установка отменена`)
  }
  if (!asset.browser_download_url || typeof asset.browser_download_url !== 'string') {
    throw new Error(`GitHub не сообщил ссылку на ${label} — установка отменена`)
  }
  return asset
}

/**
 * Resolve the sha256 digest for an asset.
 *
 * Preferred source is GitHub's own `asset.digest`. When the release predates
 * that field (or the value is not sha256), fall back to `SHA256SUMS.txt` from
 * the *same* release, downloaded from the same release's asset URL. If the
 * manifest is missing or has no line for this asset, installation aborts:
 * there is no path that installs an executable without a sha256.
 */
export async function resolveReleaseDigest(
  release: GhRelease,
  asset: GhAsset,
  label: string
): Promise<string> {
  const direct = parseSha256Digest(asset.digest)
  if (direct) return direct

  const sums = (release.assets ?? []).find(
    (candidate) =>
      candidate && typeof candidate.name === 'string' && /^SHA256SUMS(?:\.txt)?$/i.test(candidate.name)
  )
  if (!sums?.browser_download_url) {
    throw new Error(
      `GitHub не опубликовал sha256 для ${label}, а SHA256SUMS.txt в релизе отсутствует — установка отменена`
    )
  }

  let text: string
  try {
    const res = await fetchReleaseAsset(sums.browser_download_url, {
      headers: { 'User-Agent': REQUEST_HEADERS['User-Agent'] },
      timeoutMs: 30_000
    })
    if (!res.ok) throw new Error(`HTTP ${res.status}`)
    text = await res.text()
  } catch (e) {
    throw new Error(
      `Не удалось получить SHA256SUMS.txt для ${label}: ${e instanceof Error ? e.message : String(e)}`
    )
  }

  // A legitimate manifest is a few hundred bytes. Refuse anything absurd.
  if (text.length > 2 * 1024 * 1024) {
    throw new Error(`SHA256SUMS.txt для ${label} подозрительно большой — установка отменена`)
  }

  const digest = parseSha256Sums(text, asset.name)
  if (!digest) {
    throw new Error(
      `В SHA256SUMS.txt нет контрольной суммы для ${asset.name} — установка отменена`
    )
  }
  return digest
}
