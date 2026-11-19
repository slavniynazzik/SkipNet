/**
 * Owned-process control (C7) — the impure half of `process-ownership.ts`.
 *
 * Every function here either kills a PID we spawned or an enumerated process
 * whose executable path is inside our bundled resources tree. No function kills
 * by image name: `taskkill /IM winws.exe` is what used to break other people's
 * Zapret installs (AUDIT P1-10).
 */

import { execFile, spawnSync } from 'node:child_process'
import path from 'node:path'
import { tgwsBinaryPath, zapretBundleDir } from '../utils/dirs'
import { sysBin } from '../utils/sys-bin'
import {
  isOwnedImagePath,
  isTrackedProcessMatch,
  listTrackedProcesses,
  parseCimProcessIdentity,
  parseCimProcessList,
  parseTasklistCsv,
  selectOwnedKillTargets,
  untrackProcess,
  type ProcessEntry,
  type ProcessIdentity,
  type TrackedProcess
} from './process-ownership'

/** Directories whose executables belong to SkipNet. */
export function ownedProcessRoots(): string[] {
  return [zapretBundleDir(), path.dirname(tgwsBinaryPath())]
}

/**
 * PowerShell body that lists `pid|executablePath` for the requested image
 * names. `Get-CimInstance` is the only built-in that exposes the path (and it
 * is present on every supported Windows). `tasklist` is used separately for
 * cheap PID liveness checks.
 */
export function buildCimQueryScript(imageNames: readonly string[]): string {
  const filters = imageNames.map((name) => `Name='${name.replace(/'/g, "''")}'`).join(' or ')
  return (
    `Get-CimInstance Win32_Process -Filter "${filters}" | ` +
    "ForEach-Object { '{0}|{1}' -f $_.ProcessId, $_.ExecutablePath }"
  )
}

/**
 * Same query, but also emits the process creation time (Unix ms). R-12 needs
 * it to reject a recycled PID before killing a tracked process.
 */
export function buildCimIdentityQueryScript(imageNames: readonly string[]): string {
  const filters = imageNames.map((name) => `Name='${name.replace(/'/g, "''")}'`).join(' or ')
  return (
    `Get-CimInstance Win32_Process -Filter "${filters}" | ` +
    'ForEach-Object { ' +
    `$created = ''; ` +
    'if ($_.CreationDate) { ' +
    '$created = [DateTimeOffset]::new($_.CreationDate).ToUnixTimeMilliseconds() ' +
    '}; ' +
    "'{0}|{1}|{2}' -f $_.ProcessId, $_.ExecutablePath, $created }"
  )
}

function execFileAsync(
  file: string,
  args: string[],
  timeoutMs: number
): Promise<string> {
  return new Promise((resolve) => {
    execFile(
      file,
      args,
      { windowsHide: true, timeout: timeoutMs, encoding: 'utf8' },
      (error, stdout) => {
        // An error here means the process table could not be inspected. Callers
        // treat an empty list as "nothing provably ours", which is the safe
        // direction: an unknown process is never killed.
        resolve(error ? '' : `${stdout ?? ''}`)
      }
    )
  })
}

function spawnSyncOut(command: string, args: string[], timeoutMs: number): string {
  try {
    const r = spawnSync(command, args, {
      windowsHide: true,
      timeout: timeoutMs,
      encoding: 'utf8'
    })
    return r.status === 0 ? `${r.stdout ?? ''}` : ''
  } catch {
    return ''
  }
}

const POWERSHELL_ARGS = [
  '-NoProfile',
  '-NonInteractive',
  '-ExecutionPolicy',
  'Bypass',
  '-Command'
] as const

/** Enumerate the requested images with their executable paths (async). */
export async function enumerateProcesses(
  imageNames: readonly string[],
  timeoutMs = 5000
): Promise<ProcessEntry[]> {
  if (process.platform !== 'win32' || imageNames.length === 0) return []
  const out = await execFileAsync(
    sysBin('powershell.exe'),
    [...POWERSHELL_ARGS, buildCimQueryScript(imageNames)],
    timeoutMs
  )
  return parseCimProcessList(out)
}

/** Enumerate the requested images with path and creation time (async). */
export async function enumerateProcessIdentities(
  imageNames: readonly string[],
  timeoutMs = 5000
): Promise<ProcessIdentity[]> {
  if (process.platform !== 'win32' || imageNames.length === 0) return []
  const out = await execFileAsync(
    sysBin('powershell.exe'),
    [...POWERSHELL_ARGS, buildCimIdentityQueryScript(imageNames)],
    timeoutMs
  )
  return parseCimProcessIdentity(out)
}

function enumerateProcessesSync(
  imageNames: readonly string[],
  timeoutMs = 4000
): ProcessEntry[] {
  if (process.platform !== 'win32' || imageNames.length === 0) return []
  const out = spawnSyncOut(
    sysBin('powershell.exe'),
    [...POWERSHELL_ARGS, buildCimQueryScript(imageNames)],
    timeoutMs
  )
  return parseCimProcessList(out)
}

/** Enumerated processes whose executable lives in our resources tree. */
export async function enumerateOwnedProcesses(
  imageNames: readonly string[],
  roots: readonly string[] = ownedProcessRoots()
): Promise<ProcessEntry[]> {
  const entries = await enumerateProcesses(imageNames)
  return entries.filter((entry) => isOwnedImagePath(entry.imagePath, roots))
}

/** Owned processes with their creation time, so adoption can track it. */
export async function enumerateOwnedProcessIdentities(
  imageNames: readonly string[],
  roots: readonly string[] = ownedProcessRoots()
): Promise<ProcessIdentity[]> {
  const entries = await enumerateProcessIdentities(imageNames)
  return entries.filter((entry) => isOwnedImagePath(entry.imagePath, roots))
}

/** True when a process with that exact PID exists. `tasklist` CSV + `/FI`. */
export async function isProcessAlive(pid: number): Promise<boolean> {
  if (!Number.isInteger(pid) || pid <= 0) return false
  if (process.platform !== 'win32') return false
  const out = await execFileAsync(
    sysBin('tasklist.exe'),
    ['/FI', `PID eq ${pid}`, '/FO', 'CSV', '/NH'],
    2000
  )
  return parseTasklistCsv(out).some((entry) => entry.pid === pid)
}

/** Kill one process tree. Resolves once `taskkill` exits (or fails). */
export function taskkillTree(pid: number, timeoutMs = 5000): Promise<boolean> {
  return new Promise((resolve) => {
    if (!Number.isInteger(pid) || pid <= 0) {
      resolve(false)
      return
    }
    execFile(
      sysBin('taskkill.exe'),
      ['/F', '/T', '/PID', String(pid)],
      { windowsHide: true, timeout: timeoutMs },
      (error) => resolve(!error)
    )
  })
}

export function taskkillTreeSync(pid: number, timeoutMs = 5000): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false
  try {
    const r = spawnSync(sysBin('taskkill.exe'), ['/F', '/T', '/PID', String(pid)], {
      windowsHide: true,
      timeout: timeoutMs
    })
    return r.status === 0
  } catch {
    return false
  }
}

function matchesComponent(
  entry: TrackedProcess,
  component?: TrackedProcess['component']
): boolean {
  return component === undefined || entry.component === component
}

function trackedImageNames(targets: readonly TrackedProcess[]): string[] {
  const names = new Set<string>()
  for (const entry of targets) {
    const name = path.basename(entry.imagePath || '')
    if (name) names.add(name)
  }
  return [...names]
}

function verifiedTrackedPids(
  targets: readonly TrackedProcess[],
  actual: readonly ProcessIdentity[],
  roots: readonly string[]
): Set<number> {
  const byPid = new Map(actual.map((entry) => [entry.pid, entry]))
  const verified = new Set<number>()
  for (const entry of targets) {
    if (isTrackedProcessMatch(entry, byPid.get(entry.pid), roots)) {
      verified.add(entry.pid)
    } else {
      // R-12: PID reuse or a replaced executable. Leave it alone; the
      // owned-image fallback can still prove a process is ours by path.
      console.warn(
        `[process-kill] PID ${entry.pid} is no longer the tracked process — not killing it`
      )
    }
  }
  return verified
}

async function verifyTrackedTargets(
  targets: readonly TrackedProcess[]
): Promise<Set<number>> {
  if (targets.length === 0) return new Set()
  const actual = await enumerateProcessIdentities(trackedImageNames(targets))
  return verifiedTrackedPids(targets, actual, ownedProcessRoots())
}

function verifyTrackedTargetsSync(targets: readonly TrackedProcess[]): Set<number> {
  if (targets.length === 0) return new Set()
  const names = trackedImageNames(targets)
  if (names.length === 0) return new Set()
  const out = spawnSyncOut(
    sysBin('powershell.exe'),
    [...POWERSHELL_ARGS, buildCimIdentityQueryScript(names)],
    4000
  )
  return verifiedTrackedPids(targets, parseCimProcessIdentity(out), ownedProcessRoots())
}

/**
 * Kill tracked PIDs (optionally only one component) and forget them.
 * Returns the PIDs that were actually killed: a PID whose live process no
 * longer matches the tracked identity is dropped from the tracker untouched.
 */
export async function killTrackedProcesses(
  component?: TrackedProcess['component']
): Promise<number[]> {
  const targets = listTrackedProcesses(component).filter((entry) =>
    matchesComponent(entry, component)
  )
  const verified = await verifyTrackedTargets(targets)
  const killed: number[] = []
  for (const entry of targets) {
    if (verified.has(entry.pid)) {
      await taskkillTree(entry.pid)
      killed.push(entry.pid)
    }
    untrackProcess(entry.pid)
  }
  return killed
}

export function killTrackedProcessesSync(component?: TrackedProcess['component']): number[] {
  const targets = listTrackedProcesses(component)
  const verified = verifyTrackedTargetsSync(targets)
  const killed: number[] = []
  for (const entry of targets) {
    if (verified.has(entry.pid)) {
      taskkillTreeSync(entry.pid)
      killed.push(entry.pid)
    }
    untrackProcess(entry.pid)
  }
  return killed
}

/**
 * Fallback for orphaned processes: enumerate the image names and kill only the
 * entries whose executable path is inside our resources tree. Never kills by
 * image name alone.
 */
export async function killOwnedImages(
  imageNames: readonly string[],
  roots: readonly string[] = ownedProcessRoots()
): Promise<number[]> {
  if (process.platform !== 'win32') return []
  const targets = selectOwnedKillTargets({
    tracked: [],
    enumerated: await enumerateProcesses(imageNames),
    roots
  })
  for (const pid of targets) await taskkillTree(pid)
  return targets
}

export function killOwnedImagesSync(
  imageNames: readonly string[],
  roots: readonly string[] = ownedProcessRoots()
): number[] {
  if (process.platform !== 'win32') return []
  const targets = selectOwnedKillTargets({
    tracked: [],
    enumerated: enumerateProcessesSync(imageNames),
    roots
  })
  for (const pid of targets) taskkillTreeSync(pid)
  return targets
}

/**
 * Tracked-first kill used by every stop path:
 *  1. the PIDs this instance spawned for the component (identity-verified);
 *  2. the owned-image enumeration, unconditionally.
 *
 * Step 2 is not just the "orphan from a previous crash" fallback any more:
 * R-12 can reject a *live* tracked PID when its creation time cannot be proven
 * (an adopted `winws.exe` started seconds before we recorded it). Running the
 * path-based enumeration as well makes sure that process is still stopped,
 * while never touching a foreign install (the path must be inside our tree).
 */
export async function killOwnedComponent(
  component: TrackedProcess['component'],
  imageNames: readonly string[],
  roots: readonly string[] = ownedProcessRoots()
): Promise<number[]> {
  const trackedKilled = await killTrackedProcesses(component)
  const ownedKilled = await killOwnedImages(imageNames, roots)
  return [...new Set([...trackedKilled, ...ownedKilled])]
}

export function killOwnedComponentSync(
  component: TrackedProcess['component'],
  imageNames: readonly string[],
  roots: readonly string[] = ownedProcessRoots()
): number[] {
  const trackedKilled = killTrackedProcessesSync(component)
  const ownedKilled = killOwnedImagesSync(imageNames, roots)
  return [...new Set([...trackedKilled, ...ownedKilled])]
}

/**
 * Shutdown/update path: every tracked PID (both components) first, then the
 * owned-image fallback for both binaries. Runs synchronously because it is
 * called from `before-quit`/`process.on('exit')`.
 */
export function killAllOwnedSync(
  imageNames: readonly string[] = ['winws.exe', 'TgWsProxy_windows.exe'],
  roots: readonly string[] = ownedProcessRoots()
): number[] {
  const trackedKilled = killTrackedProcessesSync()
  const ownedKilled = killOwnedImagesSync(imageNames, roots)
  return [...new Set([...trackedKilled, ...ownedKilled])]
}
