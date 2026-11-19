/**
 * Persisted update-check cache.
 *
 * The cache lives in a user-writable directory (`%APPDATA%\skipnet`), so it
 * must never be able to influence *what* gets installed. Only inert display
 * metadata is stored: version, tag, release notes and timestamps. Asset URLs,
 * digests and sizes are resolved from `api.github.com` at install time (see
 * `app-updater.ts` / `zapret-updater.ts` / `tgws-updater.ts`).
 */
import { existsSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'fs'
import { randomUUID } from 'crypto'
import path from 'path'
import { dataDir } from './dirs'

export interface UpdateCacheMetadata {
  /** Release tag exactly as returned by GitHub (`v1.5.0` or `1.5.0`). */
  tag?: string
  /** Normalised version used for display and comparison (`1.5.0`). */
  version?: string
  publishedAt?: string
  hasUpdate?: boolean
  releaseNotes?: string
}

export interface PersistedUpdateCache {
  at: number
  data: UpdateCacheMetadata
}

const STRING_KEYS = ['tag', 'version', 'publishedAt', 'releaseNotes'] as const

function cachePath(name: string): string {
  return path.join(dataDir(), `update-cache-${name}.json`)
}

/**
 * Keep only fields that cannot influence the install path. Everything else
 * (including legacy `assetUrl`, `assetDigest`, `assetSize` written by older
 * builds) is dropped.
 */
function sanitizeMetadata(value: unknown): UpdateCacheMetadata | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null
  const source = value as Record<string, unknown>
  const out: UpdateCacheMetadata = {}
  for (const key of STRING_KEYS) {
    const candidate = source[key]
    if (typeof candidate === 'string' && candidate.trim()) {
      out[key] = candidate.trim()
    }
  }
  if (typeof source.hasUpdate === 'boolean') out.hasUpdate = source.hasUpdate
  return Object.keys(out).length > 0 ? out : null
}

/**
 * Synchronously load the sanitised cache for `name`. Returns `null` on any
 * failure (missing file, malformed JSON, permission glitch) — callers MUST
 * treat null as "no cache, fall through to live fetch".
 */
export function loadUpdateCache(name: string): PersistedUpdateCache | null {
  try {
    const p = cachePath(name)
    if (!existsSync(p)) return null
    const raw = readFileSync(p, 'utf8')
    const parsed = JSON.parse(raw.replace(/^\uFEFF/, '')) as {
      at?: unknown
      data?: unknown
    }
    if (!parsed || typeof parsed !== 'object') return null
    const data = sanitizeMetadata(parsed.data)
    if (!data) return null
    const now = Date.now()
    const at =
      typeof parsed.at === 'number' && Number.isFinite(parsed.at)
        ? Math.max(0, Math.min(parsed.at, now))
        : now
    return { at, data }
  } catch {
    return null
  }
}

/**
 * Best-effort sync write of the cache. Fire-and-forget — the write is
 * cheap (sub-1 KB JSON) and any I/O failure is logged via console then
 * silently swallowed; we never want a cache write to break the user's
 * actual update check.
 */
export function saveUpdateCache(name: string, data: UpdateCacheMetadata): void {
  const sanitized = sanitizeMetadata(data)
  if (!sanitized) return
  const target = cachePath(name)
  // Random + O_EXCL: the app may run elevated, and a fixed cache filename in
  // userData could be pre-created as a hardlink to a privileged file.
  const tmp = `${target}.${randomUUID()}.tmp`
  try {
    const payload: PersistedUpdateCache = { at: Date.now(), data: sanitized }
    writeFileSync(tmp, JSON.stringify(payload), { encoding: 'utf8', flag: 'wx' })
    renameSync(tmp, target)
  } catch (e) {
    try {
      unlinkSync(tmp)
    } catch {
      /* noop */
    }
    console.warn(`[update-cache:${name}] write failed:`, e)
  }
}
