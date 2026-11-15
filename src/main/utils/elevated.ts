/**
 * Helpers for actions that must run with administrator rights.
 *
 * SkipNet is manifested with `requestedExecutionLevel: requireAdministrator`,
 * so in normal operation the app already runs elevated and a direct call is
 * enough. These helpers are the fallback for the rare case where elevation was
 * stripped (portable build started through a wrapper, group policy, or a
 * developer run from a non-elevated terminal): the action is retried through
 * `Start-Process -Verb RunAs`, which shows the standard UAC prompt.
 */

import { spawnSync } from 'node:child_process'
import { unlinkSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'

export interface ElevatedRunResult {
  ok: boolean
  stdout: string
  stderr: string
}

/**
 * Run a PowerShell script body in a separate elevated PowerShell process and
 * wait for it to finish. The script is written to %TEMP% with a UTF-8 BOM so
 * PowerShell 5.1 reads Cyrillic paths correctly.
 */
export function runPowerShellElevated(body: string, timeoutMs = 60_000): ElevatedRunResult {
  const file = path.join(
    os.tmpdir(),
    `skipnet-elevated-${Date.now()}-${Math.random().toString(36).slice(2)}.ps1`
  )
  try {
    writeFileSync(file, `\ufeff${body}\r\n`, 'utf8')
    // The script path is single-quoted for PowerShell; embedded quotes are
    // escaped by doubling them.
    const quoted = file.replace(/'/g, "''")
    const launcher =
      "Start-Process -FilePath 'powershell.exe' -Verb RunAs -Wait -WindowStyle Hidden " +
      `-ArgumentList '-NoProfile','-ExecutionPolicy','Bypass','-File','${quoted}'`
    const r = spawnSync('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command', launcher], {
      windowsHide: true,
      timeout: timeoutMs,
      encoding: 'utf8'
    })
    return {
      ok: r.status === 0,
      stdout: `${r.stdout ?? ''}`,
      stderr: `${r.stderr ?? ''}`
    }
  } catch (e) {
    return { ok: false, stdout: '', stderr: e instanceof Error ? e.message : String(e) }
  } finally {
    try {
      unlinkSync(file)
    } catch {
      /* temp file — Windows will clean it eventually */
    }
  }
}

/** Single-quote a value for embedding into a PowerShell script. */
export function psQuote(value: string): string {
  return `'${value.replace(/'/g, "''")}'`
}
