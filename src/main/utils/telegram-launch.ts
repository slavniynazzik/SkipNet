/**
 * Telegram deep-link launch (T4).
 *
 * Opening `tg://` must survive a medium-integrity start, so the link is handed
 * to a one-shot Task Scheduler task running as the interactive user with
 * `/RL LIMITED`. The old implementation wrote the URL into a `.vbs` file in
 * `%TEMP%` — a proxy link contains the MTProto secret, so the secret sat on disk
 * (predictable name, readable by any process) until the delayed cleanup ran.
 *
 * Now the only artifact is an `-EncodedCommand` base64 blob inside the task's
 * `/TR`, which exists for the lifetime of the run and is deleted in `finally`.
 * Nothing is written to disk and the URL is never logged.
 */

import { execFile } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { promisify } from 'node:util'
import { shell } from 'electron'
import { encodePowerShellCommand, psQuote } from './elevated'
import { sysBin } from './sys-bin'

const execFileAsync = promisify(execFile)

export const TELEGRAM_URL_MAX_LENGTH = 4096
const CONTROL_CHARS = /[\u0000-\u001F\u007F]/ // eslint-disable-line no-control-regex
/** De-duplicates double clicks and button spam; kept from the old handler. */
export const TG_INFLIGHT_LOCK_MS = 600

let tgInflightUntil = 0

/**
 * Only `tg:` links and Telegram's own https hosts may be launched. Applied
 * before encoding, and again by `buildTelegramLaunchTask`.
 */
export function isAllowedTelegramUrl(url: string): boolean {
  if (typeof url !== 'string') return false
  if (url.length === 0 || url.length > TELEGRAM_URL_MAX_LENGTH) return false
  if (CONTROL_CHARS.test(url)) return false
  try {
    const parsed = new URL(url)
    if (parsed.protocol === 'tg:') return true
    return (
      parsed.protocol === 'https:' &&
      (parsed.hostname === 't.me' || parsed.hostname === 'telegram.me')
    )
  } catch {
    return false
  }
}

export interface TelegramLaunchTask {
  taskName: string
  /** UTF-16LE/base64 `-EncodedCommand` payload for powershell.exe. */
  encodedCommand: string
}

/**
 * Build the one-shot task payload. Throws (without echoing the URL) when the
 * link is not an allowed Telegram URL.
 *
 * The decoded script is `Start-Process -FilePath '<url>'`; `psQuote` doubles
 * every single quote so a crafted URL cannot break out of the string literal.
 */
export function buildTelegramLaunchTask(url: string, taskName?: string): TelegramLaunchTask {
  if (!isAllowedTelegramUrl(url)) {
    throw new Error('unsupported Telegram link')
  }
  const script = `Start-Process -FilePath ${psQuote(url)}`
  const encodedCommand = encodePowerShellCommand(script)
  return {
    taskName:
      taskName ??
      `SkipNet_OpenTG_${Date.now()}_${randomUUID().replace(/-/g, '').slice(0, 8)}`,
    encodedCommand
  }
}

/** `/TR` value: quoted absolute powershell.exe + no-profile hidden encoded run. */
export function buildTelegramTaskAction(encodedCommand: string): string {
  return (
    `"${sysBin('powershell.exe')}" -NoProfile -NonInteractive -WindowStyle Hidden ` +
    `-EncodedCommand ${encodedCommand}`
  )
}

function logLaunchError(stage: string, err: unknown): void {
  const message = err instanceof Error ? err.message : String(err)
  // Never include the URL: a tg:// proxy link carries the MTProto secret.
  console.error(`[openTelegramLink] ${stage}: ${message.trim()}`)
}

async function tryFallbackOpen(url: string): Promise<void> {
  try {
    await shell.openExternal(url)
  } catch (e) {
    logLaunchError('shell.openExternal', e)
  }
}

/**
 * Open a Telegram link. Never rejects: a failed scheduler run falls back to
 * `shell.openExternal`, and both paths are rate-limited by the inflight lock.
 */
export async function openTelegramLink(url: string): Promise<void> {
  if (!isAllowedTelegramUrl(url)) {
    logLaunchError('rejected url', 'unsupported scheme/host')
    return
  }
  const now = Date.now()
  if (now < tgInflightUntil) return
  tgInflightUntil = now + TG_INFLIGHT_LOCK_MS

  if (process.platform !== 'win32') {
    await tryFallbackOpen(url)
    return
  }

  let task: TelegramLaunchTask
  try {
    task = buildTelegramLaunchTask(url)
  } catch (e) {
    logLaunchError('build task', e)
    await tryFallbackOpen(url)
    return
  }

  const schtasks = sysBin('schtasks.exe')
  try {
    await execFileAsync(
      schtasks,
      [
        '/Create',
        '/F',
        '/TN',
        task.taskName,
        '/TR',
        buildTelegramTaskAction(task.encodedCommand),
        '/SC',
        'ONCE',
        // Far-future date: the task never auto-fires, we only ever /Run it.
        '/ST',
        '23:59',
        '/SD',
        '01/01/2099',
        '/IT',
        '/RL',
        'LIMITED'
      ],
      { windowsHide: true, timeout: 15_000 }
    )
    await execFileAsync(schtasks, ['/Run', '/TN', task.taskName], {
      windowsHide: true,
      timeout: 10_000
    })
  } catch (e) {
    logLaunchError('schtasks', e)
    await tryFallbackOpen(url)
  } finally {
    // Remove the task in every outcome; it is one-shot and must not linger.
    try {
      await execFileAsync(schtasks, ['/Delete', '/F', '/TN', task.taskName], {
        windowsHide: true,
        timeout: 10_000
      })
    } catch {
      /* task was never created — nothing to delete */
    }
  }
}
