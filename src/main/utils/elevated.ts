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
 */

import { spawnSync } from 'node:child_process'
import path from 'node:path'

export interface ElevatedRunResult {
  ok: boolean
  stdout: string
  stderr: string
}

function windowsRoot(): string {
  const raw = (process.env.SystemRoot || process.env.windir || 'C:\\Windows').replace(
    /[\\/]+$/,
    ''
  )
  return /^[a-z]:\\(?:Windows|WINNT)$/i.test(raw) ? raw : 'C:\\Windows'
}

function powershellPath(): string {
  return path.join(windowsRoot(), 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe')
}

/**
 * Run a PowerShell script body in a separate elevated PowerShell process and
 * wait for it to finish. The body is base64-encoded as UTF-16LE, which is what
 * `powershell.exe -EncodedCommand` expects, so Cyrillic paths stay intact.
 */
export function runPowerShellElevated(body: string, timeoutMs = 60_000): ElevatedRunResult {
  try {
    const encoded = Buffer.from(`\ufeff${body}\r\n`, 'utf16le').toString('base64')
    const file = powershellPath()
    const launcher =
      `Start-Process -FilePath ${psQuote(file)} -Verb RunAs -Wait -WindowStyle Hidden ` +
      `-ArgumentList '-NoProfile','-ExecutionPolicy','Bypass','-EncodedCommand','${encoded}'`
    const r = spawnSync(
      file,
      ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command', launcher],
      {
        windowsHide: true,
        timeout: timeoutMs,
        encoding: 'utf8'
      }
    )
    return {
      ok: r.status === 0,
      stdout: `${r.stdout ?? ''}`,
      stderr: `${r.stderr ?? ''}`
    }
  } catch (e) {
    return { ok: false, stdout: '', stderr: e instanceof Error ? e.message : String(e) }
  }
}

/** Single-quote a value for embedding into a PowerShell script. */
export function psQuote(value: string): string {
  return `'${value.replace(/'/g, "''")}'`
}
