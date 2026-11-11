/**
 * GitHub helpers with mirror fallback.
 *
 * `api.github.com`, `github.com` and `raw.githubusercontent.com` are
 * unreachable from some networks (notably Russian ISPs, where these hosts
 * are blocked). Update checks, release-asset downloads and the upstream
 * Zapret list refresh would silently stop working there, so every GitHub
 * request is retried through public HTTPS mirrors that proxy the REST API,
 * raw files and release assets.
 *
 * Mirrors are only tried when the direct request fails: users with normal
 * access never pay the extra latency, and a mirror can never mask a genuine
 * 404 (a missing asset stays missing).
 */

const MIRRORS = ['https://gh-proxy.com', 'https://ghfast.top'] as const

// Hosts whose URLs can be proxied by the mirrors above. `raw.githubusercontent.com`
// serves the upstream Zapret lists; `codeload.github.com` / `objects.githubusercontent.com`
// appear in release and archive download chains.
const GITHUB_URL_RE =
  /^https:\/\/(?:api\.github\.com|github\.com|codeload\.github\.com|raw\.githubusercontent\.com|objects\.githubusercontent\.com)\//i

export interface GithubFetchOptions {
  headers?: Record<string, string>
  /** Per-attempt timeout. Downloads should pass a much larger value. */
  timeoutMs?: number
}

function candidateUrls(url: string): string[] {
  if (!GITHUB_URL_RE.test(url)) return [url]
  return [url, ...MIRRORS.map((mirror) => `${mirror}/${url}`)]
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
 * Fetch a GitHub API/asset URL, falling back to mirrors on network errors,
 * rate limits (403/429) and upstream 5xx responses.
 */
export async function fetchGithub(url: string, opts: GithubFetchOptions = {}): Promise<Response> {
  let lastError: unknown = null

  for (const candidate of candidateUrls(url)) {
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
