/**
 * Startup elevation probe.
 *
 * Every spawn resolves through `sysBin()`: a bare `fltmc.exe` / `net.exe`
 * would be looked up in the current working directory first, and that
 * directory can be user-writable for a portable copy or a shortcut's "Start
 * in" (L2). The probe itself runs before any window exists, so a planted
 * utility next to the exe would otherwise execute elevated.
 */

import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { sysBin } from './sys-bin'

const execFilePromise = promisify(execFile)

let isAdminCached: boolean | null = null

/** Reset the memoised verdict (test seam and future profile switches). */
export function resetElevationCacheForTesting(): void {
  isAdminCached = null
}

export async function isRunningAsAdmin(): Promise<boolean> {
  if (isAdminCached !== null) {
    return isAdminCached
  }

  // `fltmc` fails for a non-elevated token with a non-zero exit code, and —
  // unlike `net session` — does not depend on the Server (LanmanServer)
  // service. On machines where that service is disabled `net session` fails
  // even for administrators, which used to make SkipNet quit with a bogus
  // "run as administrator" error.
  try {
    await execFilePromise(sysBin('fltmc.exe'), ['filters'], {
      timeout: 3000,
      windowsHide: true
    })
    isAdminCached = true
    return true
  } catch (e) {
    const code = (e as NodeJS.ErrnoException).code
    // `fltmc` is missing on a few stripped-down Windows images — fall back to
    // the legacy check instead of treating that as "not elevated".
    if (code !== 'ENOENT') {
      isAdminCached = false
      return false
    }
  }

  try {
    await execFilePromise(sysBin('net.exe'), ['session'], { timeout: 2000, windowsHide: true })
    isAdminCached = true
    return true
  } catch {
    isAdminCached = false
    return false
  }
}
