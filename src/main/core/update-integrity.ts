/**
 * Integrity primitives for the update chain.
 *
 * Deliberately free of Electron imports: every installer, archive and binary
 * that the main process downloads must go through these checks, and they must
 * be unit-testable in plain Node without an Electron runtime.
 *
 * The module is fail-closed by design: there is no "return silently" path.
 * A missing, malformed or mismatching digest is always an error.
 */
import { createHash } from 'crypto'

/** GitHub publishes digests as `sha256:<64 lowercase hex chars>`. */
const SHA256_DIGEST_RE = /^sha256:([0-9a-f]{64})$/i

/** Release tags we are willing to interpolate into an API path. */
const RELEASE_TAG_RE = /^v?\d+\.\d+\.\d+$/

export interface AssetVerification {
  /** Expected `sha256:<hex>` digest from trusted release metadata. */
  digest?: string | null
  /** Exact byte size reported by the GitHub API for this asset. */
  size?: number | null
  /** Hard lower bound; a truncated download must never pass. */
  minBytes?: number
  /** Human-readable asset description used in Russian error messages. */
  label: string
}

/** Normalise a digest string, or return `null` when it is not sha256. */
export function parseSha256Digest(value: string | undefined | null): string | null {
  const trimmed = value?.trim()
  if (!trimmed) return null
  const match = SHA256_DIGEST_RE.exec(trimmed)
  return match ? `sha256:${match[1].toLowerCase()}` : null
}

/**
 * Parse a `SHA256SUMS.txt` body and return the digest for `assetName`.
 *
 * Accepted line format is the one produced by `sha256sum` (and by our
 * `scripts/archive-release.mjs`): `<64 hex>  <name>`. Blank lines and
 * `#` comments are ignored. The binary-mode `*` marker and a leading `./`
 * are tolerated. Returns `sha256:<hex>` so the result feeds `verifyAsset`
 * directly, or `null` when no line matches.
 */
export function parseSha256Sums(text: string, assetName: string): string | null {
  const wanted = assetName?.trim().toLowerCase()
  if (!wanted) return null
  for (const rawLine of String(text ?? '').split(/\r?\n/)) {
    const line = rawLine.trim()
    if (!line || line.startsWith('#')) continue
    const match = /^([0-9a-f]{64})\s+\*?(.+)$/i.exec(line)
    if (!match) continue
    let name = match[2].trim().replace(/\\/g, '/')
    if (name.startsWith('./')) name = name.slice(2)
    const base = name.includes('/') ? name.slice(name.lastIndexOf('/') + 1) : name
    if (base.toLowerCase() !== wanted) continue
    return `sha256:${match[1].toLowerCase()}`
  }
  return null
}

/** Compare `buf` against an expected `sha256:<hex>` digest. Always throws on doubt. */
export function verifyDigest(buf: Buffer, expected: string | undefined | null, label: string): void {
  if (!expected || !expected.trim()) {
    throw new Error(`Отсутствует контрольная сумма ${label} — установка отменена`)
  }
  const normalized = parseSha256Digest(expected)
  if (!normalized) {
    throw new Error(`Некорректная контрольная сумма ${label} — установка отменена`)
  }
  const actual = createHash('sha256').update(buf).digest('hex')
  if (actual !== normalized.slice('sha256:'.length)) {
    throw new Error(`Контрольная сумма ${label} не совпадает — загрузка отклонена`)
  }
}

/**
 * Verify a downloaded asset before it is written or executed.
 *
 * Order of checks: downloadable size is known, byte count matches the API
 * metadata, the file is not implausibly small (truncated download / error
 * page), and finally the sha256 digest matches. Any missing input is fatal.
 */
export function verifyAsset(buf: Buffer, opts: AssetVerification): void {
  const { label } = opts
  if (!Buffer.isBuffer(buf) || buf.length === 0) {
    throw new Error(`Загруженный ${label} пуст — установка отменена`)
  }
  if (typeof opts.size !== 'number' || !Number.isFinite(opts.size) || opts.size <= 0) {
    throw new Error(`Не удалось определить размер ${label} — установка отменена`)
  }
  if (buf.length !== opts.size) {
    throw new Error(
      `Размер ${label} не совпадает: получено ${buf.length} байт, ожидалось ${opts.size}`
    )
  }
  const minBytes = typeof opts.minBytes === 'number' ? opts.minBytes : 0
  if (minBytes > 0 && buf.length < minBytes) {
    throw new Error(`Загруженный ${label} слишком маленький (${buf.length} байт)`)
  }
  verifyDigest(buf, opts.digest, label)
}

/** Release tags are interpolated into API paths, so keep them boring. */
export function isValidReleaseTag(tag: string): boolean {
  return RELEASE_TAG_RE.test(tag?.trim() ?? '')
}

/** Validate a renderer-supplied tag before it reaches the GitHub API. */
export function assertReleaseTag(tag: string): string {
  const value = tag?.trim() ?? ''
  if (!isValidReleaseTag(value)) {
    throw new Error('Некорректный тег версии — установка отменена')
  }
  return value
}

/**
 * The renderer may only install the release the main process last checked.
 * This prevents a compromised renderer from naming an arbitrary (older,
 * vulnerable) release.
 */
export function assertExpectedReleaseTag(tag: string, expectedTag: string | undefined): string {
  const value = assertReleaseTag(tag)
  if (!expectedTag || expectedTag.trim() !== value) {
    throw new Error(
      'Запрошенная версия не совпадает с последней проверенной — обновите список обновлений'
    )
  }
  return value
}
