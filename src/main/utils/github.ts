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

/** A legitimate checksum manifest is a few hundred bytes. */
const MAX_SUMS_BYTES = 2 * 1024 * 1024

/**
 * Candidate URLs for a fetch that must never touch a mirror.
 *
 * `SHA256SUMS.txt` is the root of trust when GitHub does not publish
 * `asset.digest`: a mirror that answers with its own manifest could pair a
 * malicious installer with a matching hash. Only the canonical
 * `github.com/.../releases/download/...` URL is accepted; anything else throws
 * before a network call. The single-element list keeps this in the same shape
 * as `releaseAssetUrlCandidates` so "no mirror" is directly assertable.
 */
export function releaseAssetDirectCandidates(url: string): string[] {
  const value = (url ?? '').trim()
  if (classifyGithubUrl(value) !== 'release-asset') {
    throw new Error(
      'Прямая загрузка разрешена только с github.com/…/releases/download/… — ' +
        'зеркала для этого файла не используются'
    )
  }
  return [value]
}

async function readBoundedText(res: Response, maxBytes: number): Promise<string> {
  const declared = res.headers?.get?.('content-length')
  if (declared) {
    const size = Number(declared)
    if (Number.isFinite(size) && size > maxBytes) {
      throw new Error(`Ответ слишком большой (${size} байт)`)
    }
  }
  const body = res.body
  if (!body) {
    const text = await res.text()
    if (Buffer.byteLength(text) > maxBytes) {
      throw new Error(`Ответ слишком большой (${Buffer.byteLength(text)} байт)`)
    }
    return text
  }
  const reader = body.getReader()
  const chunks: Buffer[] = []
  let total = 0
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    if (!value) continue
    total += value.byteLength
    if (total > maxBytes) {
      try {
        await reader.cancel()
      } catch {
        /* noop */
      }
      throw new Error(`Ответ слишком большой (${total} байт)`)
    }
    chunks.push(Buffer.from(value))
  }
  return Buffer.concat(chunks).toString('utf8')
}

/**
 * Fetch a release asset **without any mirror fallback** and with a hard byte
 * cap. Redirects to `objects.githubusercontent.com` (how github.com serves
 * release bytes) are allowed; any other final host is rejected.
 *
 * Used for trust material such as `SHA256SUMS.txt`, never for convenience.
 */
export async function fetchReleaseAssetDirect(
  url: string,
  opts: { maxBytes?: number; timeoutMs?: number } = {}
): Promise<string> {
  const [candidate] = releaseAssetDirectCandidates(url)
  const maxBytes = opts.maxBytes ?? MAX_SUMS_BYTES
  const res = await fetchOnce(candidate, {
    headers: { 'User-Agent': REQUEST_HEADERS['User-Agent'] },
    timeoutMs: opts.timeoutMs ?? 30_000
  })
  if (!res.ok) throw new Error(`GitHub ${res.status}`)
  const finalUrl = (res as { url?: string }).url
  if (finalUrl) {
    const kind = classifyGithubUrl(finalUrl)
    if (kind !== 'asset-redirect' && kind !== 'release-asset') {
      throw new Error('Загрузка перенаправлена не на сервер GitHub — отменено')
    }
  }
  return readBoundedText(res, maxBytes)
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
 * the *same* release, downloaded **directly** from github.com. Mirrors are
 * never consulted for the manifest: a mirror that can rewrite the sums can
 * pair a malicious installer with a matching hash. If the direct fetch fails
 * there is no fallback, and installation aborts.
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
    text = await fetchReleaseAssetDirect(sums.browser_download_url, {
      maxBytes: MAX_SUMS_BYTES,
      timeoutMs: 30_000
    })
  } catch (e) {
    throw new Error(
      `Не удалось получить SHA256SUMS.txt для ${label} напрямую с GitHub ` +
        `(зеркала не используются): ${e instanceof Error ? e.message : String(e)} — ` +
        'установка отменена'
    )
  }

  const digest = parseSha256Sums(text, asset.name)
  if (!digest) {
    throw new Error(
      `В SHA256SUMS.txt нет контрольной суммы для ${asset.name} — установка отменена`
    )
  }
  return digest
}
