import { appendFile, mkdir, readdir, rename, stat, unlink } from 'node:fs/promises'
import path from 'node:path'
import { BrowserWindow } from 'electron'
import { getAppConfigSync } from '../config'
import { logDir, logFileName } from './dirs'
import { redactSecrets } from './redact'

/** Rotate the active file before it grows past this size. */
export const MAX_LOG_BYTES = 5 * 1024 * 1024
export const DEFAULT_MAX_LOG_DAYS = 7

/** `app-YYYY-MM-DD.log` plus its single rotated generation. */
const LOG_FILE_RE = /^app-(\d{4})-(\d{2})-(\d{2})\.log(?:\.1)?$/

let writeQueue: Promise<void> = Promise.resolve()

function broadcast(channel: string, ...args: unknown[]): void {
  for (const w of BrowserWindow.getAllWindows()) {
    if (!w.isDestroyed()) w.webContents.send(channel, ...args)
  }
}

/**
 * Exact values that must be masked in addition to the generic patterns.
 * Read lazily: `appLog` can fire from `uncaughtException` before the app is
 * ready, so a failure to read config must never break logging.
 */
function currentSecrets(): string[] {
  try {
    const secret = getAppConfigSync().tgws?.secret
    return typeof secret === 'string' && secret.length >= 8 ? [secret] : []
  } catch {
    return []
  }
}

/**
 * Append one redacted JSONL line to the day's file.
 *
 * Exported (with an explicit directory/date) so rotation and pruning can be
 * tested against a temp dir without touching the real profile. Callers are
 * serialized by `appLog`'s queue; a concurrent second writer is not expected
 * because SkipNet is a single-instance app.
 */
export async function appendLogLine(
  dir: string,
  line: string,
  options: { date?: Date; maxBytes?: number } = {}
): Promise<string> {
  const date = options.date ?? new Date()
  const maxBytes = options.maxBytes ?? MAX_LOG_BYTES
  await mkdir(dir, { recursive: true })
  const file = path.join(dir, logFileName(date))
  const payload = Buffer.from(`${line}\n`, 'utf8')

  let size = 0
  try {
    size = (await stat(file)).size
  } catch {
    size = 0
  }
  if (size > 0 && size + payload.byteLength > maxBytes) {
    const rotated = `${file}.1`
    try {
      await unlink(rotated)
    } catch {
      /* first rotation of the day */
    }
    try {
      await rename(file, rotated)
    } catch {
      /* keep appending: losing rotation is better than losing the line */
    }
  }

  await appendFile(file, payload)
  return file
}

/**
 * Delete day files older than `maxDays` (today included in the window).
 * Returns the removed names for tests/logging.
 */
export async function pruneLogFiles(
  dir: string,
  maxDays: number = DEFAULT_MAX_LOG_DAYS,
  now: Date = new Date()
): Promise<string[]> {
  const days =
    Number.isFinite(maxDays) && maxDays > 0
      ? Math.floor(maxDays)
      : DEFAULT_MAX_LOG_DAYS
  const cutoff = new Date(now.getFullYear(), now.getMonth(), now.getDate())
  cutoff.setDate(cutoff.getDate() - (days - 1))

  let entries: string[]
  try {
    entries = await readdir(dir)
  } catch {
    return []
  }

  const removed: string[] = []
  for (const entry of entries) {
    const match = LOG_FILE_RE.exec(entry)
    if (!match) continue
    const fileDate = new Date(Number(match[1]), Number(match[2]) - 1, Number(match[3]))
    if (fileDate >= cutoff) continue
    try {
      await unlink(path.join(dir, entry))
      removed.push(entry)
    } catch {
      /* another process may have removed it */
    }
  }
  return removed
}

/**
 * Startup hook: honour `maxLogDays` from the saved config and drop old files.
 * Failures are swallowed — logging must never block startup.
 */
export async function initAppLog(): Promise<void> {
  let days = DEFAULT_MAX_LOG_DAYS
  try {
    const configured = getAppConfigSync().maxLogDays
    if (typeof configured === 'number' && Number.isFinite(configured) && configured > 0) {
      days = configured
    }
  } catch {
    /* defaults */
  }
  await pruneLogFiles(logDir(), days)
}

/** Await every queued line. Used by tests and by the quit sequence. */
export function flushLogs(): Promise<void> {
  return writeQueue
}

function queueWrite(line: string): void {
  writeQueue = writeQueue
    .then(() => appendLogLine(logDir(), line))
    .then(() => undefined)
    .catch(() => undefined)
}

export function appLog(type: ControllerLog['type'], payload: string): void {
  // Single exit point for application logs: mask `--secret`, `secret=`,
  // `tg://proxy?...secret=`, bare 32-hex keys and the exact current secret.
  // The same redacted string is broadcast and written to disk.
  const safe = redactSecrets(payload, currentSecrets())

  broadcast('log', {
    time: Date.now(),
    type,
    source: 'app',
    payload: safe
  } satisfies ControllerLog)

  // Durable JSONL copy: one line per event, one file per day, size-capped.
  // JSON.stringify escapes newlines so a multi-line stack trace stays a
  // single record.
  queueWrite(
    JSON.stringify({
      time: new Date().toISOString(),
      level: type,
      source: 'app',
      message: safe
    })
  )

  // Also mirror to stdout for dev convenience.
  const tag = type === 'error' ? '[app:error]' : type === 'warn' ? '[app:warn]' : '[app]'
  console.log(`${tag} ${safe}`)
}
