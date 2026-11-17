import { execFile } from 'child_process'
import { promisify } from 'util'

const execFilePromise = promisify(execFile)

let isAdminCached: boolean | null = null

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
    await execFilePromise('fltmc.exe', ['filters'], {
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
    await execFilePromise('net', ['session'], { timeout: 2000, windowsHide: true })
    isAdminCached = true
    return true
  } catch {
    isAdminCached = false
    return false
  }
}

