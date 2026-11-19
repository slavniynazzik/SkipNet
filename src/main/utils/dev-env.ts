import { app } from 'electron'
import { is } from '@electron-toolkit/utils'

/**
 * Single gate for `SKIPNET_*` test/seam overrides.
 *
 * A packaged build must never honour an environment variable that can point
 * the updater or the hosts catalog at another server: on Windows any process
 * running as the same user can set them before launching SkipNet. Overrides
 * therefore only apply in development (`electron-vite dev`) or in an unpacked
 * build.
 */
export function isDevEnvironment(): boolean {
  return is.dev || !app.isPackaged
}

/** Read a `SKIPNET_*` override, or `undefined` outside development. */
export function devEnv(name: string): string | undefined {
  if (!isDevEnvironment()) return undefined
  const value = process.env[name]
  const trimmed = value?.trim()
  return trimmed ? trimmed : undefined
}
