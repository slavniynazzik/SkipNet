/**
 * Helpers for actions that must run with administrator rights.
 *
 * SkipNet is manifested with `requestedExecutionLevel: requireAdministrator`,
 * so in normal operation the app already runs elevated and a direct call is
 * enough. These helpers are the fallback for the rare case where elevation was
 * stripped (portable build started through a wrapper, group policy, or a
 * developer run from a non-elevated terminal): the action is retried through
 * `Start-Process -Verb RunAs`, which shows the standard UAC prompt.
 *
 * The elevated body is passed with `-EncodedCommand` instead of a temporary
 * `.ps1` file. A file in %TEMP% can be replaced while the UAC prompt is open;
 * an encoded command line cannot.
 *
 * `Start-Process` is invoked with `-PassThru -Wait` so the launcher waits for
 * the *elevated* process and can return its exit code. Without `-PassThru`,
 * `$LASTEXITCODE`/`exit` describe `powershell.exe` itself, which always exits 0
 * when the UAC prompt is dismissed — that made a failed hosts write look like
 * a success (P1-1).
 */

import { execFile, spawnSync } from 'node:child_process'
import { promisify } from 'node:util'
import { sysBin } from './sys-bin'

const execFilePromise = promisify(execFile)

/** Buckets a caller can act on: retry, show a UAC hint, or report a script error. */
export type ElevatedOutcome = 'success' | 'uac-cancelled' | 'failed'

export interface ElevatedRunResult {
  ok: boolean
  outcome: ElevatedOutcome
  /** Exit code of the *elevated* process (null when it never started). */
  exitCode: number | null
  stdout: string
  stderr: string
}

/**
 * Marker written by the launcher when `Start-Process -Verb RunAs` itself
 * throws (user dismissed UAC, elevation blocked by policy, ...). The elevated
 * script cannot produce it, so the two failure modes stay distinguishable even
 * though both surface as a non-zero exit code.
 */
export const UAC_CANCELLED_MARKER = 'SKIPNET_UAC_CANCELLED'

/** Same numeric value as ERROR_CANCELLED, used as the launcher's exit code. */
export const UAC_CANCELLED_EXIT_CODE = 1223

function powershellPath(): string {
  return sysBin('powershell.exe')
}

/** `-EncodedCommand` payload: UTF-16LE with a BOM, base64-encoded. */
export function encodePowerShellCommand(body: string): string {
  return Buffer.from(`\ufeff${body}\r\n`, 'utf16le').toString('base64')
}

/**
 * Arguments for a hidden, non-interactive `powershell.exe -EncodedCommand`
 * run. The script never touches the filesystem before it executes, so there is
 * no `.ps1` for another process to swap while the command is starting.
 */
export function encodedPowerShellArgs(script: string): string[] {
  return [
    '-NoProfile',
    '-NonInteractive',
    '-WindowStyle',
    'Hidden',
    '-EncodedCommand',
    encodePowerShellCommand(script)
  ]
}

/**
 * Build the `-Command` script executed by the non-elevated launcher.
 *
 * Extracted as a pure function so the `-PassThru -Wait` + `exit $p.ExitCode`
 * contract has a unit test: regressing to a plain `Start-Process -Wait` would
 * silently reintroduce the false-success bug.
 */
export function buildElevatedLauncher(file: string, encodedCommand: string): string {
  return [
    '$ErrorActionPreference = "Stop"',
    'try {',
    `  $p = Start-Process -FilePath ${psQuote(file)} -Verb RunAs -PassThru -Wait -WindowStyle Hidden ` +
      `-ArgumentList '-NoProfile','-ExecutionPolicy','Bypass','-EncodedCommand','${encodedCommand}'`,
    '  exit $p.ExitCode',
    '} catch {',
    `  [Console]::Error.WriteLine('${UAC_CANCELLED_MARKER}: ' + $_.Exception.Message)`,
    `  exit ${UAC_CANCELLED_EXIT_CODE}`,
    '}'
  ].join('\r\n')
}

/**
 * Map a finished launcher run onto `{ ok, outcome, exitCode }`.
 *
 * Rules, in order: the launcher marker / ERROR_CANCELLED means UAC did not
 * happen; a spawn error means the process never started; exit code 0 is the
 * only success. A non-zero elevated exit is always a failure — the whole point
 * of CA1.
 */
export function classifyElevatedResult(input: {
  exitCode: number | null
  stdout?: string | null
  stderr?: string | null
  error?: string | null
}): ElevatedRunResult {
  const stdout = input.stdout ?? ''
  const stderr = input.stderr ?? ''
  const exitCode = input.exitCode

  if (stderr.includes(UAC_CANCELLED_MARKER) || exitCode === UAC_CANCELLED_EXIT_CODE) {
    return { ok: false, outcome: 'uac-cancelled', exitCode, stdout, stderr }
  }
  if (input.error) {
    return {
      ok: false,
      outcome: 'failed',
      exitCode,
      stdout,
      stderr: stderr || input.error
    }
  }
  if (exitCode === 0) {
    return { ok: true, outcome: 'success', exitCode, stdout, stderr }
  }
  return {
    ok: false,
    outcome: 'failed',
    exitCode,
    stdout,
    stderr: stderr || `elevated process exited with code ${exitCode ?? 'unknown'}`
  }
}

/**
 * Run a PowerShell script body in a separate elevated PowerShell process and
 * wait for it to finish. The body is base64-encoded as UTF-16LE, which is what
 * `powershell.exe -EncodedCommand` expects, so Cyrillic paths stay intact.
 *
 * Synchronous by design: every existing caller is a synchronous
 * read-modify-write of a system file, and the timeout bounds the wait.
 */
export function runPowerShellElevated(body: string, timeoutMs = 60_000): ElevatedRunResult {
  try {
    const encoded = encodePowerShellCommand(body)
    const file = powershellPath()
    const launcher = buildElevatedLauncher(file, encoded)
    const r = spawnSync(
      file,
      ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command', launcher],
      {
        windowsHide: true,
        timeout: timeoutMs,
        encoding: 'utf8'
      }
    )
    return classifyElevatedResult({
      exitCode: r.status,
      stdout: r.stdout,
      stderr: r.stderr,
      error: r.error ? r.error.message : null
    })
  } catch (e) {
    return {
      ok: false,
      outcome: 'failed',
      exitCode: null,
      stdout: '',
      stderr: e instanceof Error ? e.message : String(e)
    }
  }
}

/** Single-quote a value for embedding into a PowerShell script. */
export function psQuote(value: string): string {
  return `'${value.replace(/'/g, "''")}'`
}

/* -------------------------------------------------------------------------- */
/* Startup elevation probe                                                    */
/* -------------------------------------------------------------------------- */

let isAdminCached: boolean | null = null

/** Reset the memoised verdict (test seam and future profile switches). */
export function resetElevationCacheForTesting(): void {
  isAdminCached = null
}

/**
 * True when the current process token is elevated.
 *
 * Every spawn resolves through `sysBin()`: a bare `fltmc.exe` / `net.exe`
 * would be looked up in the current working directory first, and that
 * directory can be user-writable for a portable copy or a shortcut's "Start
 * in" (L2). The probe itself runs before any window exists, so a planted
 * utility next to the exe would otherwise execute elevated.
 *
 * `fltmc` fails for a non-elevated token with a non-zero exit code and —
 * unlike `net session` — does not depend on the Server (LanmanServer) service.
 * On machines where that service is disabled `net session` fails even for
 * administrators, which used to make SkipNet quit with a bogus "run as
 * administrator" error.
 */
export async function isRunningAsAdmin(): Promise<boolean> {
  if (isAdminCached !== null) {
    return isAdminCached
  }

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
