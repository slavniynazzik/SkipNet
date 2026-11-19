import path from 'node:path'
import { fileURLToPath } from 'node:url'

export interface TrustedFrameOptions {
  /**
   * `process.env.ELECTRON_RENDERER_URL` in dev (set by electron-vite), or
   * `undefined`/empty in a packaged build.
   */
  devUrl?: string | null
  /** Absolute path to the built `out/renderer/index.html`. */
  prodIndexPath: string
}

/** Protocols that never carry our renderer, regardless of configuration. */
const REJECTED_PROTOCOLS = new Set(['about:', 'data:', 'blob:'])

/**
 * Decide whether an IPC sender / navigation target is the SkipNet renderer.
 *
 * Packaged: only the exact `file://` URL of our own `out/renderer/index.html`
 * is trusted. Comparing origins is useless for `file://` (Chromium reports the
 * origin as the string `"null"` for every local file), so the resolved path is
 * compared instead.
 *
 * Dev: only the exact origin of `ELECTRON_RENDERER_URL` is trusted. A prefix
 * check would accept `http://localhost:5173.evil.example`, so origins are
 * compared after `URL` normalisation.
 *
 * Everything else — `about:`, `data:`, `blob:`, other files, other origins and
 * malformed input — is rejected (fail closed).
 */
export function isTrustedFrameUrl(
  url: string | null | undefined,
  { devUrl, prodIndexPath }: TrustedFrameOptions
): boolean {
  if (!url) return false

  let parsed: URL
  try {
    parsed = new URL(url)
  } catch {
    return false
  }

  if (REJECTED_PROTOCOLS.has(parsed.protocol)) return false

  if (parsed.protocol === 'file:') {
    try {
      return path.resolve(fileURLToPath(parsed)) === path.resolve(prodIndexPath)
    } catch {
      // Malformed file URL (missing host/encoding, etc.).
      return false
    }
  }

  if (devUrl) {
    try {
      return parsed.origin === new URL(devUrl).origin
    } catch {
      return false
    }
  }

  return false
}
