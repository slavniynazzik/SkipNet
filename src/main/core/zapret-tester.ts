/**
 * Zapret strategy sweep ("тест стратегий").
 *
 * The checks themselves are a native port of the bundle's own
 * `utils/test zapret.ps1` (the engine behind `service.bat` → "12. Run Tests"),
 * so the GUI reports the same numbers the console does:
 *
 *  - targets are read from `utils/targets.txt` (`Key = "https://…"` and
 *    `Key = "PING:1.2.3.4"`), with the same built-in fallback list;
 *  - every URL is probed with `curl.exe` three times: `--http1.1`,
 *    `--tlsv1.2 --tls-max 1.2`, `--tlsv1.3 --tls-max 1.3`
 *    (`-I -s -m 4 --connect-timeout 2 -o NUL -w "%{http_code}" --show-error`);
 *  - DNS-hijack / certificate errors are reported as `SSL`, curl exit 35 and
 *    "unsupported protocol" as `UNSUP`, exit 0 as `OK`, everything else `ERROR`;
 *  - each target is also pinged with a 1 s timeout (ICMP);
 *  - a strategy is ranked by HTTP OK count, ties broken by ping OK count —
 *    exactly the upstream analytics + `Best strategy:` rule;
 *  - target probes run in parallel (`min(16, max(8, cpus * 2))`), like the
 *    upstream runspace pool.
 *
 * The sweep plumbing is SkipNet's own: the 10-minute deadline, cooperative
 * cancellation, Start/Stop pre-emption and the restore of the previous
 * strategy. Those are not test semantics, they are lifecycle guarantees.
 */

import { spawn, ChildProcess } from 'child_process'
import { existsSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'fs'
import { randomUUID } from 'crypto'
import os from 'os'
import path from 'path'
import { app } from 'electron'
import { dataDir, zapretBundleDir } from '../utils/dirs'
import { sysBin } from '../utils/sys-bin'
import { broadcast as broadcastToAll } from '../utils/broadcast'
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

// ---- Upstream test semantics ---------------------------------------------

/** Timeout for one `curl.exe` invocation (`$standardCurlTimeout = 4`). */
const CURL_TIMEOUT_S = 4
/** `--connect-timeout min(2, 4)`. */
const CURL_CONNECT_TIMEOUT_S = 2
/** ICMP timeout used by `System.Net.NetworkInformation.Ping.Send(host, 1000)`. */
const PING_TIMEOUT_MS = 1000
/** `Wait-WinwsReady` polls for 5 s. */
const STRATEGY_BOOT_TIMEOUT_MS = 5000
/** `Wait-WinwsReady` sleeps 300 ms after winws.exe becomes visible. */
const STRATEGY_SETTLE_MS = 300
/** Hard kill guard in case curl.exe hangs despite `-m`. */
const CURL_KILL_MS = (CURL_TIMEOUT_S + 4) * 1000

/** Upstream `targets.txt` fallback, verbatim (`Add-OrSet` block). */
const DEFAULT_TARGETS: TestTarget[] = [
  { name: 'Discord Main', url: 'https://discord.com', pingTarget: 'discord.com' },
  { name: 'Discord Gateway', url: 'https://gateway.discord.gg', pingTarget: 'gateway.discord.gg' },
  { name: 'Discord CDN', url: 'https://cdn.discordapp.com', pingTarget: 'cdn.discordapp.com' },
  { name: 'Discord Updates', url: 'https://updates.discord.com', pingTarget: 'updates.discord.com' },
  { name: 'YouTube Web', url: 'https://www.youtube.com', pingTarget: 'www.youtube.com' },
  { name: 'YouTube Short', url: 'https://youtu.be', pingTarget: 'youtu.be' },
  { name: 'YouTube Image', url: 'https://i.ytimg.com', pingTarget: 'i.ytimg.com' },
  {
    name: 'YouTube Video Redirect',
    url: 'https://redirector.googlevideo.com',
    pingTarget: 'redirector.googlevideo.com'
  },
  { name: 'Google Main', url: 'https://www.google.com', pingTarget: 'www.google.com' },
  { name: 'Google Gstatic', url: 'https://www.gstatic.com', pingTarget: 'www.gstatic.com' },
  { name: 'Cloudflare Web', url: 'https://www.cloudflare.com', pingTarget: 'www.cloudflare.com' },
  { name: 'Cloudflare CDN', url: 'https://cdnjs.cloudflare.com', pingTarget: 'cdnjs.cloudflare.com' },
  { name: 'Cloudflare DNS 1.1.1.1', pingTarget: '1.1.1.1' },
  { name: 'Cloudflare DNS 1.0.0.1', pingTarget: '1.0.0.1' },
  { name: 'Google DNS 8.8.8.8', pingTarget: '8.8.8.8' },
  { name: 'Google DNS 8.8.4.4', pingTarget: '8.8.4.4' },
  { name: 'Quad9 DNS 9.9.9.9', pingTarget: '9.9.9.9' }
]

/** Parallel probes per strategy, same formula as the upstream script. */
export function probeConcurrency(): number {
  return Math.min(16, Math.max(8, os.cpus().length * 2))
}

export interface TestTarget {
  name: string
  /** HTTP(S) URL; absent for PING-only targets. */
  url?: string
  /** Host passed to ICMP ping; absent when the entry has no host. */
  pingTarget?: string
}

export type HttpCheckLabel = 'HTTP' | 'TLS1.2' | 'TLS1.3'
export type HttpCheckStatus = 'ok' | 'error' | 'unsup' | 'ssl'

export interface HttpCheck {
  label: HttpCheckLabel
  status: HttpCheckStatus
}

export interface TargetProbeResult {
  name: string
  /** True when the target came from an `https://…` entry. */
  isUrl: boolean
  /** Empty for PING-only targets. */
  checks: HttpCheck[]
  ping: 'ok' | 'fail' | 'n/a'
  pingMs?: number
}

const TARGET_LINE = /^\s*(\w+)\s*=\s*"(.+)"\s*$/

/**
 * Parse `targets.txt`. The upstream script keeps an ordered dictionary and
 * silently ignores malformed lines, so a comment or a broken entry never
 * aborts a run.
 */
export function parseTargets(text: string): TestTarget[] {
  const targets: TestTarget[] = []
  for (const line of text.split(/\r?\n/)) {
    const m = TARGET_LINE.exec(line)
    if (!m) continue
    const name = m[1]
    const value = m[2].trim()
    if (!value) continue
    if (/^PING:/i.test(value)) {
      const host = value.replace(/^PING:\s*/i, '').trim()
      if (host) targets.push({ name, pingTarget: host })
    } else {
      targets.push({
        name,
        url: value,
        pingTarget: value.replace(/^https?:\/\//i, '').replace(/\/.*$/, '')
      })
    }
  }
  return targets
}

/** Upstream fallback list. */
export function defaultTargets(): TestTarget[] {
  return DEFAULT_TARGETS.map((t) => ({ ...t }))
}

// curl error classification, lifted from `test zapret.ps1`.
const DNS_HIJACK_RE =
  /Could not resolve host|certificate|SSL certificate problem|self[- ]?signed|certificate verify failed|unable to get local issuer certificate/i
const UNSUPPORTED_RE =
  /does not support|not supported|protocol\s+'?.+'?\s+not\s+supported|unsupported protocol|TLS.*not supported|Unrecognized option|Unknown option|unsupported option|unsupported feature|schannel/i

export function classifyCurl(exitCode: number | null, stderr: string): HttpCheckStatus {
  if (DNS_HIJACK_RE.test(stderr)) return 'ssl'
  if (exitCode === 35 || UNSUPPORTED_RE.test(stderr)) return 'unsup'
  if (exitCode === 0) return 'ok'
  return 'error'
}

const HTTP_CHECKS: Array<{ label: HttpCheckLabel; args: string[] }> = [
  { label: 'HTTP', args: ['--http1.1'] },
  { label: 'TLS1.2', args: ['--tlsv1.2', '--tls-max', '1.2'] },
  { label: 'TLS1.3', args: ['--tlsv1.3', '--tls-max', '1.3'] }
]

export interface CurlOutcome {
  exitCode: number | null
  stdout: string
  stderr: string
}

/** Run one `curl.exe` probe with upstream's exact argument list. */
export function runCurl(args: string[]): Promise<CurlOutcome> {
  return new Promise((resolve) => {
    let stdout = ''
    let stderr = ''
    let settled = false
    const child = spawn(sysBin('curl.exe'), args, { windowsHide: true })
    const done = (exitCode: number | null): void => {
      if (settled) return
      settled = true
      clearTimeout(guard)
      resolve({ exitCode, stdout, stderr })
    }
    const guard = setTimeout(() => {
      try {
        child.kill()
      } catch {
        /* noop */
      }
      done(null)
    }, CURL_KILL_MS)
    child.stdout?.on('data', (d: Buffer) => {
      stdout += d.toString('utf8')
    })
    child.stderr?.on('data', (d: Buffer) => {
      stderr += d.toString('utf8')
    })
    child.on('error', (e) => {
      stderr += ` ${e.message}`
      done(null)
    })
    // `close` (not `exit`) guarantees stdout/stderr were fully drained.
    child.on('close', (code) => done(code))
  })
}

async function probeUrl(url: string): Promise<HttpCheck[]> {
  const checks: HttpCheck[] = []
  for (const test of HTTP_CHECKS) {
    const outcome = await runCurl([
      '-I',
      '-s',
      '-m',
      String(CURL_TIMEOUT_S),
      '--connect-timeout',
      String(Math.min(CURL_CONNECT_TIMEOUT_S, CURL_TIMEOUT_S)),
      '-o',
      'NUL',
      '-w',
      '%{http_code}',
      '--show-error',
      ...test.args,
      url
    ])
    checks.push({ label: test.label, status: classifyCurl(outcome.exitCode, outcome.stderr) })
  }
  return checks
}

/** ICMP ping via the same Windows stack the upstream script uses. */
export function pingHost(host: string): Promise<{ ok: boolean; ms?: number }> {
  return new Promise((resolve) => {
    // Windows `ping.exe` writes in the OEM code page (cp866 on Russian
    // systems), so the "время=12мс"/"time=12ms" token must be decoded before
    // looking for the unit. Only the numeric value is surfaced.
    const chunks: Buffer[] = []
    let settled = false
    const child = spawn(sysBin('ping.exe'), ['-n', '1', '-w', String(PING_TIMEOUT_MS), host], {
      windowsHide: true
    })
    const done = (ok: boolean, ms?: number): void => {
      if (settled) return
      settled = true
      clearTimeout(guard)
      resolve({ ok, ms })
    }
    const guard = setTimeout(() => {
      try {
        child.kill()
      } catch {
        /* noop */
      }
      done(false)
    }, PING_TIMEOUT_MS + 4000)
    child.stdout?.on('data', (d: Buffer) => {
      chunks.push(d)
    })
    child.stderr?.on('data', () => void 0)
    child.on('error', () => done(false))
    child.on('close', (code) => {
      if (code !== 0) {
        done(false)
        return
      }
      const buf = Buffer.concat(chunks)
      let stdout: string
      try {
        stdout = new TextDecoder('ibm866').decode(buf)
      } catch {
        stdout = buf.toString('latin1')
      }
      // "time=12ms", "время=12мс", "tiempo=12ms", "time<1ms".
      const m = /[=<]\s*(\d+)\s*(?:мс|ms|msec|мсек)/i.exec(stdout) ??
        /=\s*(\d+)\s*[^\s=]{1,4}\s+TTL=/i.exec(stdout)
      done(true, m ? Number(m[1]) : undefined)
    })
  })
}

async function mapPool<T, R>(
  items: T[],
  limit: number,
  fn: (item: T, index: number) => Promise<R>
): Promise<R[]> {
  const out: R[] = new Array(items.length)
  let next = 0
  const workers = Array.from({ length: Math.max(1, Math.min(limit, items.length)) }, async () => {
    for (;;) {
      const index = next++
      if (index >= items.length) return
      out[index] = await fn(items[index], index)
    }
  })
  await Promise.all(workers)
  return out
}

export async function probeTargets(
  targets: TestTarget[],
  signal: AbortSignal
): Promise<TargetProbeResult[]> {
  return mapPool(targets, probeConcurrency(), async (target) => {
    if (signal.aborted) {
      return { name: target.name, isUrl: !!target.url, checks: [], ping: 'n/a' }
    }
    const [checks, ping] = await Promise.all([
      target.url ? probeUrl(target.url) : Promise.resolve([]),
      target.pingTarget
        ? pingHost(target.pingTarget)
        : Promise.resolve({ ok: false, ms: undefined })
    ])
    return {
      name: target.name,
      isUrl: !!target.url,
      checks,
      ping: target.pingTarget ? (ping.ok ? 'ok' : 'fail') : 'n/a',
      pingMs: ping.ms
    }
  })
}

// ---- Report model ---------------------------------------------------------

export interface StrategyTestResult {
  tested: true
  /**
   * At least one HTTP/TLS check succeeded. This is upstream's primary
   * ranking metric ("HTTP OK"), not an invented pass threshold.
   */
  passed: boolean
  /** HTTP OK checks across all URL targets (upstream `HTTP OK`). */
  okCount: number
  /** `ERROR` + `SSL` checks (upstream `ERR`). */
  errorCount: number
  /** `UNSUP` checks. */
  unsupportedCount: number
  /** Successful ICMP pings (upstream `Ping OK`). */
  pingOkCount: number
  /** Timed-out pings (upstream `Fail`). */
  pingFailCount: number
  /** Number of HTTP checks (URL targets × 3). */
  totalCount: number
  /** `okCount / totalCount` for sorting/back-compat. */
  score: number
  targets: TargetProbeResult[]
}

export interface StrategyTestReport {
  ranAt: number
  durationMs: number
  bundleVersion?: string
  results: Record<string, StrategyTestResult>
  bestStrategy?: string
  /** True when the sweep was stopped early (cancel, deadline or pre-empt). */
  cancelled?: boolean
  /** Which upstream suite produced this report. */
  mode?: 'standard'
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
    // Pre-1.6 reports came from the old HEAD-probe engine and are not
    // comparable with upstream HTTP/TLS/ping analytics — ignore them.
    if (
      parsed &&
      parsed.mode === 'standard' &&
      typeof parsed.ranAt === 'number' &&
      parsed.results
    ) {
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

function emitProgress(payload: TestProgress): void {
  broadcastToAll('zapret:testProgress', payload)
}

const RESULTS_FILENAME = 'zapret-test-results.json'
/** Hard ceiling for one sweep, whatever the strategy count. */
export const STRATEGY_TEST_DEADLINE_MS = 10 * 60_000
/**
 * After a Start/Stop pre-empts the sweep, give the new owner this long to
 * become observable before the next strategy may start. Two winws.exe
 * instances must never overlap.
 */
const PREEMPT_SETTLE_MS = 1000
const PREEMPT_POLL_MS = 100

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

/** Plain timer for the pre-emption settle window (must not short-circuit). */
function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
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
  targets: () => TestTarget[]
  status: () => CoreStatus
  getConfig: () => Promise<AppConfig | null>
  withZapretLock: <T>(fn: () => Promise<T>) => Promise<T>
  killWinws: () => Promise<void>
  killChildTree: (pid: number | undefined) => Promise<void>
  spawnStrategy: (batPath: string) => StrategyChild
  isWinwsRunning: () => Promise<boolean>
  ensureWinDivertReady: () => void
  probeAll: (signal: AbortSignal) => Promise<TargetProbeResult[]>
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

/** Read `utils/targets.txt`, falling back to the upstream defaults. */
export function loadBundleTargets(bundleDir: string): TestTarget[] {
  try {
    const file = path.join(bundleDir, 'utils', 'targets.txt')
    if (!existsSync(file)) return defaultTargets()
    const parsed = parseTargets(readFileSync(file, 'utf8').replace(/^\uFEFF/, ''))
    return parsed.length > 0 ? parsed : defaultTargets()
  } catch {
    return defaultTargets()
  }
}

function defaultDeps(): StrategyTesterDeps {
  return {
    bundleDir: zapretBundleDir,
    verifyBundle: verifyZapretBundle,
    strategies: listStrategies,
    targets: () => loadBundleTargets(zapretBundleDir()),
    status: getZapretStatus,
    getConfig: () => getAppConfig().catch(() => null),
    withZapretLock,
    killWinws,
    killChildTree,
    spawnStrategy,
    isWinwsRunning,
    ensureWinDivertReady: () => ensureWinDivertReady(),
    probeAll: (signal) => probeTargets(loadBundleTargets(zapretBundleDir()), signal),
    startZapret,
    broadcast: emitProgress,
    saveReport,
    exists: existsSync,
    now: () => Date.now()
  }
}

/** Turn per-target probe output into upstream's analytics counters. */
export function summarizeProbes(targets: TargetProbeResult[]): {
  okCount: number
  errorCount: number
  unsupportedCount: number
  pingOkCount: number
  pingFailCount: number
  totalCount: number
  score: number
} {
  let okCount = 0
  let errorCount = 0
  let unsupportedCount = 0
  let pingOkCount = 0
  let pingFailCount = 0
  for (const target of targets) {
    for (const check of target.checks) {
      if (check.status === 'ok') okCount++
      else if (check.status === 'unsup') unsupportedCount++
      else errorCount++
    }
    if (target.ping === 'ok') pingOkCount++
    else if (target.ping === 'fail') pingFailCount++
  }
  const totalCount = targets.reduce((n, t) => n + t.checks.length, 0)
  return {
    okCount,
    errorCount,
    unsupportedCount,
    pingOkCount,
    pingFailCount,
    totalCount,
    score: totalCount === 0 ? 0 : okCount / totalCount
  }
}

interface StrategyScore {
  okCount: number
  errorCount: number
  unsupportedCount: number
  pingOkCount: number
  pingFailCount: number
  totalCount: number
  score: number
  passed: boolean
  targets: TargetProbeResult[]
}

/**
 * A strategy that never produced traffic still occupies a row in the report.
 * Reserving `null` for cancellation is what keeps one broken strategy from
 * silently truncating the whole sweep (B3).
 */
function zeroScore(totalCount: number): StrategyScore {
  return {
    okCount: 0,
    errorCount: 0,
    unsupportedCount: 0,
    pingOkCount: 0,
    pingFailCount: 0,
    totalCount,
    score: 0,
    passed: false,
    targets: []
  }
}

/**
 * Run one strategy and score it. Returns null only when the sweep was
 * cancelled; a strategy that fails to spawn or boot scores zero so the caller
 * can continue with the next one.
 *
 * The operation lock is held only around the clean-up + spawn boundary; boot
 * wait and probes run outside it so Start/Stop are never blocked for more than
 * a moment.
 */
async function testOneStrategy(
  batPath: string,
  signal: AbortSignal,
  deps: StrategyTesterDeps,
  totalHttpChecks: number
): Promise<StrategyScore | null> {
  // Same fail-closed check startZapretImpl uses. Verified before we touch the
  // running bypass or spawn anything: a tampered strategy must never be
  // executed just because the user pressed "run tests".
  deps.verifyBundle(deps.bundleDir())
  if (signal.aborted) return null

  // Boundary: kill leftovers and spawn under the lock; release before boot.
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

  // Cancel promptly, but never leak an unowned child: the abort can land after
  // `spawnStrategy` ran and before the queued lock section resolved. Await the
  // spawn and kill whatever it produced before returning.
  await Promise.race([spawnPromise, aborted(signal)])
  const child = await spawnPromise
  if (signal.aborted) {
    if (child) await deps.killChildTree(child.pid)
    return null
  }
  // Spawn failure (missing .bat, cmd.exe refused, lock rejected) = zero score,
  // not cancellation: the sweep continues with the next strategy.
  if (!child) return zeroScore(totalHttpChecks)

  // A Start/Stop that pre-empted us owns winws.exe now; only that path waits
  // for the new instance, a plain cancel must return immediately.
  const preempted = (): boolean =>
    signal.aborted && activeRun?.reason === 'preempted'

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
    if (signal.aborted) return null
    // Never booted (exited immediately or stayed invisible) — score it zero
    // and move on instead of ending the sweep.
    if (!booted) return zeroScore(totalHttpChecks)

    // Upstream `Wait-WinwsReady`: 300 ms after the process appears.
    await abortableSleep(STRATEGY_SETTLE_MS, signal)
    if (signal.aborted) return null

    const targets = await deps.probeAll(signal)
    if (signal.aborted) return null
    const summary = summarizeProbes(targets)
    return {
      ...summary,
      passed: summary.okCount > 0,
      targets
    }
  } finally {
    // Always drop our own tree first, even when a Start/Stop pre-empted us.
    await deps.killChildTree(child.pid)
    if (preempted()) {
      // Wait until the new owner is observable (or a short bound elapses) so
      // the next iteration cannot start a second winws.exe on top of it.
      const bound = deps.now() + PREEMPT_SETTLE_MS
      while (deps.now() < bound) {
        try {
          if (await deps.isWinwsRunning()) break
        } catch {
          break
        }
        await sleep(PREEMPT_POLL_MS)
      }
    } else {
      await deps.killWinws()
      await abortableSleep(400, signal)
    }
  }
}

/**
 * Upstream `Best strategy:` rule — highest HTTP OK, ties broken by ping OK.
 * Object insertion order follows the strategy list, so ties resolve exactly
 * like the script's OrderedDictionary loop.
 */
export function chooseBestStrategy(
  results: Record<string, StrategyTestResult>
): string | undefined {
  let best: string | undefined
  let maxScore = 0
  let maxPing = -1
  for (const [file, result] of Object.entries(results)) {
    if (result.okCount > maxScore) {
      maxScore = result.okCount
      maxPing = result.pingOkCount
      best = file
    } else if (result.okCount === maxScore && result.pingOkCount > maxPing) {
      maxPing = result.pingOkCount
      best = file
    }
  }
  return best
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

      // `test zapret.ps1` refuses to run without curl.exe; fail with the same
      // clarity instead of scoring 22 configs as dead.
      if (!deps.exists(sysBin('curl.exe'))) {
        throw new Error(
          'curl.exe не найден в System32 — тестирование невозможно. service.bat проверяет его так же.'
        )
      }

      const strategies = deps.strategies()
      const total = strategies.length
      if (total === 0) {
        const empty: StrategyTestReport = {
          ranAt: startedAt,
          durationMs: 0,
          results: {},
          mode: 'standard'
        }
        deps.saveReport(empty)
        deps.broadcast({ phase: 'completed', report: empty })
        return empty
      }

      const targets = deps.targets()
      const totalHttpChecks = targets.filter((t) => t.url).length * HTTP_CHECKS.length

      const cfg = await deps.getConfig().catch(() => null)
      const wasRunning = deps.status().state === 'running'

      deps.broadcast({ phase: 'starting', total, current: 0 })

      const results: Record<string, StrategyTestResult> = {}
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
            results[s.file] = { tested: true, ...zeroScore(totalHttpChecks) }
            continue
          }
          try {
            const r = await testOneStrategy(batPath, signal, deps, totalHttpChecks)
            // `null` means the sweep was cancelled; a zero-scored strategy is
            // still an object, so a broken strategy never ends the sweep.
            if (!r) break
            results[s.file] = { tested: true, ...r }
          } catch (e) {
            if (signal.aborted) break
            console.warn(`[zapret-tester] ${s.file} threw:`, e)
            results[s.file] = { tested: true, ...zeroScore(totalHttpChecks) }
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
        bestStrategy: chooseBestStrategy(results),
        mode: 'standard',
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
