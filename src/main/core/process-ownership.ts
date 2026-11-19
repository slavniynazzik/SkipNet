/**
 * Process ownership rules (C7).
 *
 * SkipNet runs elevated and shares `winws.exe` / `TgWsProxy_windows.exe` image
 * names with unrelated tools (another Zapret checkout, a standalone TgWsProxy,
 * a fork). Killing by image name (`taskkill /IM`) therefore destroys other
 * people's installations. This module decides which processes are *ours*:
 *
 *  1. a PID we spawned ourselves (the tracker below), or
 *  2. a process whose executable path is inside our bundled resources tree.
 *
 * Pure predicates + a tiny in-memory registry; no I/O and no Electron imports,
 * so every rule here is unit-testable. The spawning/enumerating side lives in
 * `process-kill.ts`.
 */

import path from 'node:path'

export interface ProcessEntry {
  pid: number
  imagePath: string
}

/** A process table entry with the start time CIM exposed for it. */
export interface ProcessIdentity extends ProcessEntry {
  /** Creation time in Unix milliseconds, when Windows reported one. */
  creationTime?: number
}

/**
 * `startedAt` is recorded with `Date.now()` in the parent, while CIM reports
 * the child's creation time with a different clock source. Two seconds covers
 * the spawn latency and rounding without ever accepting a recycled PID that
 * started in a previous session.
 */
export const TRACKED_PID_CREATION_TOLERANCE_MS = 2000

/** One process SkipNet spawned (or adopted as its own child). */
export interface TrackedProcess {
  pid: number
  imagePath: string
  startedAt: number
  /**
   * Which component owns the process. Used so `killWinws()` never tears down
   * the Telegram proxy (and vice versa).
   */
  component?: 'zapret' | 'tgws'
}

const tracked = new Map<number, TrackedProcess>()

/** Normalise a Windows path for case-insensitive comparison, `/` or `\`. */
function normalizeForCompare(value: string): string {
  return value
    .replace(/^\\\\\?\\/, '')
    .replace(/\//g, '\\')
    .replace(/\\+$/, '')
    .toLowerCase()
}

/** True when the raw string contains a `..` path segment. */
export function hasParentSegment(value: string): boolean {
  return value.split(/[\\/]+/).some((segment) => segment === '..')
}

/**
 * True when `imagePath` points at a file *inside* one of `roots`.
 *
 * - resolved before comparison, so `\foo\..\bar` cannot escape a root;
 * - any raw `..` segment is rejected outright (defence in depth);
 * - comparison is case-insensitive and separator-insensitive;
 * - the root itself is not an executable path, so equality is not owned.
 */
export function isOwnedImagePath(imagePath: string, roots: readonly string[]): boolean {
  if (typeof imagePath !== 'string') return false
  const raw = imagePath.trim()
  if (!raw) return false
  if (hasParentSegment(raw)) return false
  if (roots.length === 0) return false

  const target = normalizeForCompare(path.resolve(raw))
  if (!target) return false

  for (const root of roots) {
    if (typeof root !== 'string' || !root.trim() || hasParentSegment(root)) continue
    const base = normalizeForCompare(path.resolve(root))
    if (!base) continue
    if (target === base) continue
    if (target.startsWith(`${base}\\`)) return true
  }
  return false
}

/** Split one CSV line, honouring the `""` escape used by `tasklist /FO CSV`. */
function splitCsvLine(line: string): string[] {
  const fields: string[] = []
  let i = 0
  while (i <= line.length) {
    if (line[i] === '"') {
      let value = ''
      i += 1
      while (i < line.length) {
        if (line[i] === '"' && line[i + 1] === '"') {
          value += '"'
          i += 2
          continue
        }
        if (line[i] === '"') {
          i += 1
          break
        }
        value += line[i]
        i += 1
      }
      fields.push(value)
      if (line[i] === ',') i += 1
      continue
    }
    let end = line.indexOf(',', i)
    if (end === -1) end = line.length
    fields.push(line.slice(i, end))
    i = end + 1
    if (end === line.length) break
  }
  return fields
}

/**
 * Parse `tasklist /FO CSV /NH` output.
 *
 * Rows look like `"winws.exe","4321","Console","1","12 345 КБ"`. The
 * `INFO: No tasks are running…` line (and any localised equivalent without a
 * numeric PID) is skipped. Only image name + PID are kept: `tasklist` does not
 * expose the executable path, so its PIDs are never enough to authorise a kill.
 */
export function parseTasklistCsv(text: string): Array<{ imageName: string; pid: number }> {
  const out: Array<{ imageName: string; pid: number }> = []
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim()
    if (!line || /^INFO:/i.test(line)) continue
    const fields = splitCsvLine(line)
    if (fields.length < 2) continue
    const pid = Number.parseInt(fields[1], 10)
    if (!Number.isInteger(pid) || pid <= 0) continue
    out.push({ imageName: fields[0], pid })
  }
  return out
}

/**
 * Parse the `pid|executablePath` lines produced by the `Get-CimInstance
 * Win32_Process` query in `process-kill.ts`. `|` cannot appear in a Windows
 * path, so a single split is unambiguous.
 */
export function parseCimProcessList(text: string): ProcessEntry[] {
  const out: ProcessEntry[] = []
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim()
    if (!line) continue
    const sep = line.indexOf('|')
    if (sep <= 0) continue
    const pid = Number.parseInt(line.slice(0, sep), 10)
    const imagePath = line.slice(sep + 1).trim()
    if (!Number.isInteger(pid) || pid <= 0 || !imagePath) continue
    out.push({ pid, imagePath })
  }
  return out
}

/**
 * Parse `pid|executablePath|creationTimeMs` lines produced by the identity
 * query in `process-kill.ts`. The third field is optional: a Windows build that
 * cannot expose the creation time still yields a usable path-only identity.
 */
export function parseCimProcessIdentity(text: string): ProcessIdentity[] {
  const out: ProcessIdentity[] = []
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim()
    if (!line) continue
    const first = line.indexOf('|')
    if (first <= 0) continue
    const pid = Number.parseInt(line.slice(0, first), 10)
    if (!Number.isInteger(pid) || pid <= 0) continue

    const rest = line.slice(first + 1)
    const second = rest.lastIndexOf('|')
    const imagePath = (second >= 0 ? rest.slice(0, second) : rest).trim()
    if (!imagePath) continue

    const parsedTime = second >= 0 ? Number.parseInt(rest.slice(second + 1).trim(), 10) : NaN
    const entry: ProcessIdentity = { pid, imagePath }
    if (Number.isFinite(parsedTime) && parsedTime > 0) entry.creationTime = parsedTime
    out.push(entry)
  }
  return out
}

/** Case/separator-insensitive equality of two absolute Windows paths. */
export function isSameImagePath(candidate: string, recorded: string): boolean {
  if (typeof candidate !== 'string' || typeof recorded !== 'string') return false
  const left = candidate.trim()
  const right = recorded.trim()
  if (!left || !right) return false
  if (hasParentSegment(left) || hasParentSegment(right)) return false
  return normalizeForCompare(path.resolve(left)) === normalizeForCompare(path.resolve(right))
}

/**
 * R-12: may a tracked PID still be killed?
 *
 * The tracker remembers what *we* spawned, but Windows recycles PIDs. Before a
 * stop/quit tears a process down, the live process must still (a) exist under
 * the same PID, (b) execute from a SkipNet-owned directory **or** be the exact
 * image path recorded at spawn (the Zapret launcher is `cmd.exe`, a system
 * binary outside our resources tree), and (c) — when both the tracker and CIM
 * have a start time — have started within two seconds of that recorded spawn.
 * Anything else is treated as "not ours" and left alive.
 */
export function isTrackedProcessMatch(
  tracked: TrackedProcess,
  actual: ProcessIdentity | undefined,
  roots: readonly string[]
): boolean {
  if (!tracked || !actual) return false
  if (actual.pid !== tracked.pid) return false
  const sameImage =
    isOwnedImagePath(actual.imagePath, roots) ||
    isSameImagePath(actual.imagePath, tracked.imagePath)
  if (!sameImage) return false
  if (
    typeof actual.creationTime === 'number' &&
    typeof tracked.startedAt === 'number' &&
    Number.isFinite(actual.creationTime) &&
    Number.isFinite(tracked.startedAt) &&
    tracked.startedAt > 0
  ) {
    if (Math.abs(actual.creationTime - tracked.startedAt) > TRACKED_PID_CREATION_TOLERANCE_MS) {
      return false
    }
  }
  return true
}

/**
 * Decide which PIDs a stop may terminate.
 *
 * Tracked PIDs win: they are the processes this SkipNet instance spawned, even
 * if their path cannot be inspected (CIM unavailable). Only when nothing is
 * tracked does the enumerated process table matter, and then only entries whose
 * executable path is inside our resources tree. A foreign `winws.exe` is never
 * returned.
 */
export function selectOwnedKillTargets(input: {
  tracked: readonly TrackedProcess[]
  enumerated: readonly ProcessEntry[]
  roots: readonly string[]
}): number[] {
  const pids = new Set<number>()
  if (input.tracked.length > 0) {
    for (const entry of input.tracked) {
      if (Number.isInteger(entry.pid) && entry.pid > 0) pids.add(entry.pid)
    }
    return [...pids]
  }
  for (const entry of input.enumerated) {
    if (!Number.isInteger(entry.pid) || entry.pid <= 0) continue
    if (isOwnedImagePath(entry.imagePath, input.roots)) pids.add(entry.pid)
  }
  return [...pids]
}

// ---- spawn tracker ---------------------------------------------------------

/** Remember a process we spawned. Ignores a missing/invalid PID. */
export function trackProcess(
  pid: number | undefined,
  imagePath: string,
  component?: TrackedProcess['component'],
  startedAt = Date.now()
): TrackedProcess | null {
  if (!pid || !Number.isInteger(pid) || pid <= 0) return null
  const entry: TrackedProcess = { pid, imagePath, startedAt, component }
  tracked.set(pid, entry)
  return entry
}

export function untrackProcess(pid: number | undefined): void {
  if (!pid) return
  tracked.delete(pid)
}

export function listTrackedProcesses(component?: TrackedProcess['component']): TrackedProcess[] {
  const all = [...tracked.values()]
  return component ? all.filter((entry) => entry.component === component) : all
}

export function clearTrackedProcesses(): void {
  tracked.clear()
}
