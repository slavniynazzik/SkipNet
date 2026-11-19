/**
 * Zapret strategy sweep ("тест стратегий").
 *
 * The sweep has to start and stop winws.exe once per strategy, which is why it
 * needs to cooperate with the normal Start/Stop controls. Before CA5 it held
 * `withZapretLock` for the whole 4–6 minute run, so a user toggle simply hung.
 *
 * Now:
 *  - the operation lock is taken only at short boundaries (clean-up + spawn,
 *    and the final clean-up), never across the warm-up or the HTTPS probes;
 *  - the run registers a cancellable session with `zapret.ts`; `startZapret`
 *    and `stopZapret` pre-empt it instead of queueing behind it;
 *  - an `AbortController` (and the `zapret:cancelStrategyTest` channel) stops
 *    the current strategy, persists a report with `cancelled: true` and
 *    restores the strategy that was active before the sweep;
 *  - a hard 10-minute deadline and the app `before-quit` hook abort it too.
 */

import { spawn, ChildProcess } from 'child_process'
import { existsSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'fs'
import { randomUUID } from 'crypto'
import path from 'path'
import { app, BrowserWindow } from 'electron'
import { dataDir, zapretBundleDir } from '../utils/dirs'
import { sysBin } from '../utils/sys-bin'
import { taskkillTree } from './process-kill'
import { trackProcess, untrackProcess } from './process-ownership'
import {
  ensureWinDivertReady,
  getZapretStatus,
  isWinwsRunning,
  killWinws,
  listStrategies,
  registerStrategyTestSession,
  startZapret,
  unregisterStrategyTestSession,
  withZapretLock,
  type StrategyDescriptor
} from './zapret'
import { getAppConfig } from '../config'
import { verifyZapretBundle } from './binary-integrity'

// HTTPS hosts that DPI bypass solutions are typically tested against.
const HTTP_TARGETS: string[] = [
  'https://discord.com',
  'https://gateway.discord.gg',
  'https://cdn.discordapp.com',
  'https://updates.discord.com',
  'https://www.youtube.com',
  'https://youtu.be',
  'https://i.ytimg.com',
  'https://www.google.com',
  'https://www.gstatic.com',
  'https://www.cloudflare.com'
]

const PROBE_TIMEOUT_MS = 5000
const STRATEGY_WARMUP_MS = 4500
const STRATEGY_BOOT_TIMEOUT_MS = 6000
const PASS_THRESHOLD = 0.5
const RESULTS_FILENAME = 'zapret-test-results.json'
/** Hard ceiling for one sweep, whatever the strategy count. */
export const STRATEGY_TEST_DEADLINE_MS = 10 * 60_000

// Same shape as the renderer-side type in renderer/utils/ipc.ts —
// kept duplicated to avoid leaking renderer types into main code.
export interface StrategyTestResult {
  passed: boolean
  okCount: number
  totalCount: number
  score: number
  tested: true
}

export interface StrategyTestReport {
  ranAt: number
  durationMs: number
  bundleVersion?: string
  results: Record<string, StrategyTestResult>
  bestStrategy?: string
  /** True when the sweep was stopped early (cancel, deadline or pre-empt). */
  cancelled?: boolean
}

export interface TestProgress {
  phase: 'starting' | 'testing' | 'completed' | 'error' | 'idle'
  current?: number
  total?: number
  strategy?: string
  report?: StrategyTestReport
  message?: string
}

/** Why a sweep stopped early. */
export type StrategyTestCancelReason = 'user' | 'preempted' | 'deadline' | 'quit'

interface ActiveRun {
  controller: AbortController
  reason: StrategyTestCancelReason | null
}

let runningPromise: Promise<StrategyTestReport> | null = null
let activeRun: ActiveRun | null = null
let cachedReport: StrategyTestReport | null = null

function resultsPath(): string {
  return path.join(dataDir(), RESULTS_FILENAME)
}

export function getStrategyTestResults(): StrategyTestReport | null {
  if (cachedReport) return cachedReport
  try {
    const p = resultsPath()
    if (!existsSync(p)) return null
    const raw = readFileSync(p, 'utf8')
    const parsed = JSON.parse(raw.replace(/^\uFEFF/, '')) as StrategyTestReport
    if (parsed && typeof parsed.ranAt === 'number' && parsed.results) {
      cachedReport = parsed
      return parsed
    }
    return null
  } catch {
    return null
  }
}

function saveReport(report: StrategyTestReport): void {
  const target = resultsPath()
  const tmp = `${target}.${randomUUID()}.tmp`
  try {
    writeFileSync(tmp, JSON.stringify(report, null, 2), { encoding: 'utf8', flag: 'wx' })
    renameSync(tmp, target)
    cachedReport = report
  } catch (e) {
    try {
      unlinkSync(tmp)
    } catch {
      /* noop */
    }
    console.warn('[zapret-tester] save report failed:', e)
  }
}

function broadcast(payload: TestProgress): void {
  for (const w of BrowserWindow.getAllWindows()) {
    if (!w.isDestroyed()) w.webContents.send('zapret:testProgress', payload)
  }
}

interface ProbeResult {
  url: string
  ok: boolean
  status?: number
  ms: number
  error?: string
}

/** Resolves as soon as `signal` aborts (or never, when no signal is given). */
function aborted(signal?: AbortSignal): Promise<null> {
  return new Promise((resolve) => {
    if (!signal) return
    if (signal.aborted) {
      resolve(null)
      return
    }
    signal.addEventListener('abort', () => resolve(null), { once: true })
  })
}

/** `setTimeout` that resolves early when the sweep is cancelled. */
function abortableSleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal?.aborted) {
      resolve()
      return
    }
    let timer: NodeJS.Timeout | null = null
    const onAbort = (): void => {
      if (timer) clearTimeout(timer)
      resolve()
    }
    timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort)
      resolve()
    }, ms)
    signal?.addEventListener('abort', onAbort, { once: true })
  })
}

async function probeOne(url: string, signal?: AbortSignal): Promise<ProbeResult> {
  const t0 = Date.now()
  const ctrl = new AbortController()
  const timer = setTimeout(() => ctrl.abort(), PROBE_TIMEOUT_MS)
  const onAbort = (): void => ctrl.abort()
  signal?.addEventListener('abort', onAbort, { once: true })
  try {
    const res = await fetch(url, {
      method: 'HEAD',
      redirect: 'manual',
      signal: ctrl.signal,
      // Don't reuse keep-alive sockets across strategies — each strategy
      // gets a clean WinDivert filter, so an old socket might bypass it.
      headers: { Connection: 'close' }
    })
    return {
      url,
      // 2xx/3xx (incl. manual redirect) and 4xx all mean the server is up.
      ok: res.status >= 200 && res.status < 600,
      status: res.status,
      ms: Date.now() - t0
    }
  } catch (e) {
    return {
      url,
      ok: false,
      error: e instanceof Error ? e.message : String(e),
      ms: Date.now() - t0
    }
  } finally {
    clearTimeout(timer)
    signal?.removeEventListener('abort', onAbort)
  }
}

async function probeAll(signal?: AbortSignal): Promise<ProbeResult[]> {
  return Promise.all(HTTP_TARGETS.map((url) => probeOne(url, signal)))
}

function killChildTree(pid: number | undefined): Promise<void> {
  if (!pid) return Promise.resolve()
  untrackProcess(pid)
  return taskkillTree(pid).then(() => undefined)
}

/** The parts of a `ChildProcess` the sweep actually uses (fake-able in tests). */
export interface StrategyChild {
  pid?: number
  exitCode?: number | null
}

export interface StrategyTesterDeps {
  bundleDir: () => string
  verifyBundle: (dir: string) => void
  strategies: () => StrategyDescriptor[]
  status: () => CoreStatus
  getConfig: () => Promise<AppConfig | null>
  withZapretLock: <T>(fn: () => Promise<T>) => Promise<T>
  killWinws: () => Promise<void>
  killChildTree: (pid: number | undefined) => Promise<void>
  spawnStrategy: (batPath: string) => StrategyChild
  isWinwsRunning: () => Promise<boolean>
  ensureWinDivertReady: () => void
  probeAll: (signal: AbortSignal) => Promise<ProbeResult[]>
  startZapret: () => Promise<void>
  broadcast: (payload: TestProgress) => void
  saveReport: (report: StrategyTestReport) => void
  exists: (file: string) => boolean
  now: () => number
}

function spawnStrategy(batPath: string): ChildProcess {
  const dir = zapretBundleDir()
  const c = spawn(sysBin('cmd.exe'), ['/c', batPath], {
    cwd: dir,
    windowsHide: true,
    detached: false,
    env: {
      ...process.env,
      // Same flag startZapretImpl uses to skip the .bat's own GitHub
      // update check on cold start.
      NO_UPDATE_CHECK: '1'
    }
  })
  // Track it: a start/stop that pre-empts the sweep kills tracked PIDs only.
  trackProcess(c.pid, sysBin('cmd.exe'), 'zapret')
  c.on('exit', () => untrackProcess(c.pid))
  // Drain stdio so the child process buffer doesn't fill up and stall
  // winws.exe — we don't care about test-time logs in main's logs UI.
  c.stdout?.on('data', () => void 0)
  c.stderr?.on('data', () => void 0)
  c.on('error', () => void 0)
  return c
}

function defaultDeps(): StrategyTesterDeps {
  return {
    bundleDir: zapretBundleDir,
    verifyBundle: verifyZapretBundle,
    strategies: listStrategies,
    status: getZapretStatus,
    getConfig: () => getAppConfig().catch(() => null),
    withZapretLock,
    killWinws,
    killChildTree,
    spawnStrategy,
    isWinwsRunning,
    ensureWinDivertReady: () => ensureWinDivertReady(),
    probeAll: (signal) => probeAll(signal),
    startZapret,
    broadcast,
    saveReport,
    exists: existsSync,
    now: () => Date.now()
  }
}

interface StrategyScore {
  okCount: number
  totalCount: number
  score: number
  passed: boolean
}

/**
 * Run one strategy and score it. Returns null when the sweep was cancelled.
 *
 * The operation lock is held only around the clean-up + spawn boundary; the
 * warm-up and probes run outside it so Start/Stop are never blocked for more
 * than a moment.
 */
async function testOneStrategy(
  batPath: string,
  signal: AbortSignal,
  deps: StrategyTesterDeps
): Promise<StrategyScore | null> {
  // Same fail-closed check startZapretImpl uses. Verified before we touch the
  // running bypass or spawn anything: a tampered strategy must never be
  // executed just because the user pressed "run tests".
  deps.verifyBundle(deps.bundleDir())
  if (signal.aborted) return null

  // Boundary: kill leftovers and spawn under the lock; release before warm-up.
  const spawnPromise = deps
    .withZapretLock(async () => {
      if (signal.aborted) return null
      // Defensive cleanup of any winws.exe still lingering from the previous
      // iteration (and to make the boot probe unambiguous).
      await deps.killWinws()
      await abortableSleep(250, signal)
      if (signal.aborted) return null
      // Make sure the WinDivert driver is loaded BEFORE winws.exe launches —
      // the same preflight startZapretImpl uses, otherwise the first .bat in
      // the sweep tends to fail-load the driver.
      try {
        deps.ensureWinDivertReady()
      } catch {
        /* best effort */
      }
      return deps.spawnStrategy(batPath)
    })
    .catch(() => null)

  // If a user Start/Stop pre-empted us while we were queued for the lock, do
  // not keep waiting: the queued section above re-checks the signal and no-ops.
  const child = await Promise.race([spawnPromise, aborted(signal)])
  if (!child || signal.aborted) {
    if (child) await deps.killChildTree(child.pid)
    return null
  }

  let preempted = false
  try {
    const deadline = deps.now() + STRATEGY_BOOT_TIMEOUT_MS
    let booted = false
    while (deps.now() < deadline) {
      if (signal.aborted) return null
      if (await deps.isWinwsRunning()) {
        booted = true
        break
      }
      if (child.exitCode !== null && child.exitCode !== undefined) break
      await abortableSleep(150, signal)
    }
    if (!booted || signal.aborted) return null

    // Extra warmup so winws.exe finishes binding WinDivert filters before we
    // hit it with traffic. Empirically 4-5s is the minimum.
    await abortableSleep(STRATEGY_WARMUP_MS, signal)
    if (signal.aborted) return null

    const results = await deps.probeAll(signal)
    if (signal.aborted) return null
    const okCount = results.filter((r) => r.ok).length
    const totalCount = results.length
    const score = totalCount === 0 ? 0 : okCount / totalCount
    return { okCount, totalCount, score, passed: score >= PASS_THRESHOLD }
  } finally {
    preempted = signal.aborted
    await deps.killChildTree(child.pid)
    // When a Start/Stop pre-empted the sweep, the new owner of winws.exe is
    // responsible for it — killing by image name here would kill their
    // process. `taskkill /T` above is enough to drop our own tree.
    if (!preempted) await deps.killWinws()
    await abortableSleep(400, signal)
  }
}

/**
 * Run the sweep. Resolves with the persisted report; never rejects for a
 * cancelled run (`cancelled: true` in the report instead).
 */
export function runStrategyTestsWith(deps: StrategyTesterDeps): Promise<StrategyTestReport> {
  if (runningPromise) return runningPromise

  const controller = new AbortController()
  const run: ActiveRun = { controller, reason: null }
  activeRun = run
  const { signal } = controller

  let releaseDone: () => void = () => undefined
  const stopped = new Promise<void>((resolve) => {
    releaseDone = resolve
  })
  const session = {
    abort: () => {
      cancelStrategyTest('preempted')
    },
    done: stopped
  }
  registerStrategyTestSession(session)

  const promise = (async (): Promise<StrategyTestReport> => {
    // Make sure `runningPromise` is assigned before any early return below.
    await Promise.resolve()
    const startedAt = deps.now()

    try {
      // Abort the whole sweep before killing the user's running bypass or
      // spawning any strategy. Tampered payloads are never executed.
      deps.verifyBundle(deps.bundleDir())

      const strategies = deps.strategies()
      const total = strategies.length
      if (total === 0) {
        const empty: StrategyTestReport = {
          ranAt: startedAt,
          durationMs: 0,
          results: {}
        }
        deps.saveReport(empty)
        deps.broadcast({ phase: 'completed', report: empty })
        return empty
      }

      const cfg = await deps.getConfig().catch(() => null)
      const wasRunning = deps.status().state === 'running'

      deps.broadcast({ phase: 'starting', total, current: 0 })

      const results: Record<string, StrategyTestResult> = {}
      let bestStrategy: string | undefined
      let bestScore = -1
      let testError: Error | null = null
      const overallDeadline = startedAt + STRATEGY_TEST_DEADLINE_MS

      try {
        // User's zapret was running — kill it once (short lock) so the first
        // strategy is not measured on top of an existing filter.
        if (wasRunning) {
          await deps.withZapretLock(() => deps.killWinws())
          await abortableSleep(500, signal)
        }

        for (let i = 0; i < strategies.length; i++) {
          if (signal.aborted) break
          if (deps.now() > overallDeadline) {
            cancelStrategyTest('deadline')
            break
          }
          const s = strategies[i]
          deps.broadcast({
            phase: 'testing',
            current: i + 1,
            total,
            strategy: s.file
          })
          const batPath = path.join(deps.bundleDir(), s.file)
          if (!deps.exists(batPath)) {
            results[s.file] = {
              tested: true,
              passed: false,
              okCount: 0,
              totalCount: HTTP_TARGETS.length,
              score: 0
            }
            continue
          }
          try {
            const r = await testOneStrategy(batPath, signal, deps)
            if (!r) break
            results[s.file] = { tested: true, ...r }
            if (r.passed && r.score > bestScore) {
              bestScore = r.score
              bestStrategy = s.file
            }
          } catch (e) {
            if (signal.aborted) break
            console.warn(`[zapret-tester] ${s.file} threw:`, e)
            results[s.file] = {
              tested: true,
              passed: false,
              okCount: 0,
              totalCount: HTTP_TARGETS.length,
              score: 0
            }
          }
        }
      } catch (e) {
        if (!signal.aborted) testError = e instanceof Error ? e : new Error(String(e))
      }

      // Stop whatever the last strategy left behind. A pre-empting Start/Stop
      // already owns winws.exe, so only clean up when we still own it.
      if (signal.aborted && run.reason !== 'preempted') {
        try {
          await deps.withZapretLock(() => deps.killWinws())
        } catch {
          /* surfaced through status */
        }
      }

      // Let a pre-empting Start/Stop continue *before* we try to take the
      // lock again for the restore (otherwise both wait on each other).
      releaseDone()

      const cancelled = signal.aborted
      const report: StrategyTestReport = {
        ranAt: startedAt,
        durationMs: deps.now() - startedAt,
        bundleVersion: cfg?.zapret?.installedVersion,
        results,
        bestStrategy,
        ...(cancelled ? { cancelled: true } : {})
      }
      deps.saveReport(report)

      // Restore the bypass that was running before the sweep — but never
      // contradict an explicit Start/Stop that pre-empted us, and do nothing
      // during shutdown.
      const restore =
        wasRunning &&
        (!cancelled || run.reason === 'user' || run.reason === 'deadline')
      if (restore) {
        try {
          await deps.startZapret()
        } catch {
          /* surfaced via status */
        }
      }

      if (testError) {
        deps.broadcast({ phase: 'error', message: testError.message, report })
      } else {
        deps.broadcast({ phase: 'completed', report })
      }
      return report
    } finally {
      releaseDone()
      unregisterStrategyTestSession(session)
      if (activeRun === run) activeRun = null
      // No newer sweep can have replaced this one (the entry point reuses the
      // in-flight promise), so clearing unconditionally is safe.
      runningPromise = null
    }
  })()

  runningPromise = promise
  return promise
}

/** Real dependencies; tests use `runStrategyTestsWith` with fakes. */
export function runStrategyTests(): Promise<StrategyTestReport> {
  return runStrategyTestsWith(defaultDeps())
}

/**
 * Abort the sweep in flight. Returns true when something was running.
 *
 * The report is still persisted (with `cancelled: true`) and the previous
 * strategy is restored, so cancelling never leaves the user without a bypass.
 */
export function cancelStrategyTest(reason: StrategyTestCancelReason = 'user'): boolean {
  const run = activeRun
  if (!run) return false
  if (!run.reason) run.reason = reason
  run.controller.abort()
  return true
}

export function isStrategyTestRunning(): boolean {
  return runningPromise !== null
}

// A sweep must never outlive the app: an orphan winws.exe mid-test would leave
// the user's network in an unknown state.
app.on('before-quit', () => {
  cancelStrategyTest('quit')
})
