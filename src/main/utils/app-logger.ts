import { BrowserWindow } from 'electron'
import { getAppConfigSync } from '../config'
import { redactSecrets } from './redact'

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

export function appLog(type: ControllerLog['type'], payload: string): void {
  // Single exit point for application logs: mask `--secret`, `secret=`,
  // `tg://proxy?...secret=`, bare 32-hex keys and the exact current secret.
  const safe = redactSecrets(payload, currentSecrets())
  broadcast('log', {
    time: Date.now(),
    type,
    source: 'app',
    payload: safe
  } satisfies ControllerLog)
  // Also mirror to stdout for dev convenience.
  const tag = type === 'error' ? '[app:error]' : type === 'warn' ? '[app:warn]' : '[app]'
  console.log(`${tag} ${safe}`)
}
