/**
 * Filesystem helpers that survive antivirus / indexer interference.
 *
 * On Windows `rename(2)` over an existing file fails with `EPERM`, `EACCES` or
 * `EBUSY` while Defender, a backup agent or the search indexer holds an open
 * handle on the destination. The handle is released within milliseconds, so a
 * short retry loop turns a spurious "настройки не сохраняются" into a
 * successful atomic replace.
 */

import { rename } from 'node:fs/promises'

/** Errors that mean "another process is holding the file", not "bad path". */
const RETRYABLE_CODES = new Set(['EPERM', 'EACCES', 'EBUSY'])

export const RENAME_ATTEMPTS = 5
export const RENAME_DELAY_MS = 100

export interface RenameWithRetryOptions {
  /** Injected for tests; defaults to `fs/promises.rename`. */
  rename?: (from: string, to: string) => Promise<void>
  attempts?: number
  delayMs?: number
  /** Injected for tests; defaults to a real timer. */
  sleep?: (ms: number) => Promise<void>
}

function defaultSleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

function errorCode(error: unknown): string | undefined {
  return (error as NodeJS.ErrnoException | undefined)?.code
}

/**
 * Rename `from` to `to`, retrying only the transient Windows sharing errors.
 * Any other error (ENOENT, EXDEV, ...) is rethrown immediately: retrying it
 * would just delay the real failure.
 */
export async function renameWithRetry(
  from: string,
  to: string,
  options: RenameWithRetryOptions = {}
): Promise<void> {
  const doRename = options.rename ?? rename
  const attempts = Math.max(1, options.attempts ?? RENAME_ATTEMPTS)
  const delayMs = Math.max(0, options.delayMs ?? RENAME_DELAY_MS)
  const sleep = options.sleep ?? defaultSleep

  for (let attempt = 1; ; attempt += 1) {
    try {
      await doRename(from, to)
      return
    } catch (error) {
      const code = errorCode(error)
      const retryable = code !== undefined && RETRYABLE_CODES.has(code)
      if (!retryable || attempt >= attempts) throw error
      await sleep(delayMs)
    }
  }
}
