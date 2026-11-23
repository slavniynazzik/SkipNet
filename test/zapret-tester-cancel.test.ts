/**
 * CA5 / audit P1-17: the strategy sweep must be cancellable and must not hold
 * the Zapret operation lock for minutes.
 *
 * Every dependency is injected, so the whole sweep runs on fake timers: no
 * winws.exe, no network, no real 4.5 s warm-ups.
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  cancelStrategyTest,
  chooseBestStrategy,
  classifyCurl,
  defaultTargets,
  isStrategyTestRunning,
  loadBundleTargets,
  parseTargets,
  runStrategyTestsWith,
  summarizeProbes,
  type StrategyTesterDeps,
  type StrategyTestReport,
  type TargetProbeResult,
  type TestProgress
} from '@main/core/zapret-tester'
import type { StrategyDescriptor } from '@main/core/zapret'

const okChecks = (): TargetProbeResult['checks'] => [
  { label: 'HTTP', status: 'ok' },
  { label: 'TLS1.2', status: 'ok' },
  { label: 'TLS1.3', status: 'ok' }
]

function okResults(): TargetProbeResult[] {
  return [
    { name: 'Discord', isUrl: true, checks: okChecks(), ping: 'ok', pingMs: 5 },
    { name: 'YouTube', isUrl: true, checks: okChecks(), ping: 'ok', pingMs: 7 },
    { name: 'DNS', isUrl: false, checks: [], ping: 'ok', pingMs: 2 }
  ]
}

const TEST_TARGETS = [
  { name: 'Discord', url: 'https://discord.com', pingTarget: 'discord.com' },
  { name: 'YouTube', url: 'https://www.youtube.com', pingTarget: 'www.youtube.com' },
  { name: 'DNS', pingTarget: '1.1.1.1' }
]

function strategy(file: string): StrategyDescriptor {
  return { file, title: file, description: '' }
}

interface FakeDeps extends StrategyTesterDeps {
  events: TestProgress[]
  reports: StrategyTestReport[]
  killedPids: number[]
  startCalls: number
  maxLockHoldMs: number
}

function makeDeps(overrides: Partial<StrategyTesterDeps> = {}): FakeDeps {
  const events: TestProgress[] = []
  const reports: StrategyTestReport[] = []
  const killedPids: number[] = []
  let pid = 100
  let lockDepth = 0
  let lockSince = 0
  const deps: FakeDeps = {
    events,
    reports,
    killedPids,
    startCalls: 0,
    maxLockHoldMs: 0,
    bundleDir: () => 'C:\\fake\\zapret',
    verifyBundle: () => undefined,
    strategies: () => ['general1.bat', 'general2.bat', 'general3.bat'].map(strategy),
    targets: () => TEST_TARGETS,
    status: () => ({ state: 'running' }),
    getConfig: async () => null,
    withZapretLock: async (fn) => {
      lockDepth += 1
      if (lockDepth === 1) lockSince = Date.now()
      try {
        return await fn()
      } finally {
        lockDepth -= 1
        if (lockDepth === 0) {
          deps.maxLockHoldMs = Math.max(deps.maxLockHoldMs, Date.now() - lockSince)
        }
      }
    },
    killWinws: async () => undefined,
    killChildTree: async (childPid) => {
      if (childPid) killedPids.push(childPid)
    },
    spawnStrategy: () => ({ pid: (pid += 1) - 1, exitCode: null }),
    isWinwsRunning: async () => true,
    ensureWinDivertReady: () => undefined,
    probeAll: async () => okResults(),
    startZapret: async () => {
      deps.startCalls += 1
    },
    broadcast: (payload) => {
      events.push(payload)
    },
    saveReport: (report) => {
      reports.push(report)
    },
    exists: () => true,
    now: () => Date.now(),
    ...overrides
  }
  return deps
}

afterEach(() => {
  // Make sure a failing assertion cannot leak a running sweep into the next
  // test: cancel + flush is idempotent.
  cancelStrategyTest('quit')
  vi.useRealTimers()
})

describe('strategy sweep cancellation', () => {
  it('cancels in well under 2 s, persists cancelled: true and restores the previous strategy', async () => {
    vi.useFakeTimers()
    const deps = makeDeps()

    const run = runStrategyTestsWith(deps)
    // Reach the first strategy's probes (spawn boundary 250 ms, 300 ms settle).
    await vi.advanceTimersByTimeAsync(1000)
    expect(deps.events.some((event) => event.phase === 'testing')).toBe(true)
    expect(isStrategyTestRunning()).toBe(true)

    const cancelAt = Date.now()
    let resolvedAt = 0
    void run.then(() => {
      resolvedAt = Date.now()
    })

    expect(cancelStrategyTest('user')).toBe(true)
    // The sweep should settle on microtasks alone; 1900 fake ms is a hard cap.
    await vi.advanceTimersByTimeAsync(1900)
    const report = await run

    expect(resolvedAt).toBeGreaterThanOrEqual(cancelAt)
    expect(resolvedAt - cancelAt).toBeLessThan(2000)
    expect(report.cancelled).toBe(true)
    expect(deps.reports.at(-1)?.cancelled).toBe(true)
    // The strategy that was running before the sweep is started again.
    expect(deps.startCalls).toBe(1)
    // The strategy child we spawned is always cleaned up.
    expect(deps.killedPids.length).toBeGreaterThan(0)
    // The operation lock was never held across the warm-up/probe phase.
    expect(deps.maxLockHoldMs).toBeLessThan(1000)
    expect(isStrategyTestRunning()).toBe(false)
  })

  it('does not restore or fight a Start/Stop that pre-empted the sweep', async () => {
    vi.useFakeTimers()
    const deps = makeDeps()

    const run = runStrategyTestsWith(deps)
    await vi.advanceTimersByTimeAsync(1000)

    // This is exactly what `startZapret`/`stopZapret` call before taking over.
    expect(cancelStrategyTest('preempted')).toBe(true)
    await vi.advanceTimersByTimeAsync(1900)
    const report = await run

    expect(report.cancelled).toBe(true)
    // The user's own action owns winws.exe now.
    expect(deps.startCalls).toBe(0)
    expect(deps.killedPids.length).toBeGreaterThan(0)
  })

  it('stops at the 10-minute overall deadline', async () => {
    vi.useFakeTimers()
    let probes = 0
    const deps = makeDeps({
      probeAll: async () => {
        probes += 1
        return okResults()
      },
      // After the first strategy the clock reports > 10 minutes elapsed.
      now: () => (probes > 0 ? Date.now() + 11 * 60_000 : Date.now())
    })

    const run = runStrategyTestsWith(deps)
    // 250 spawn + 300 settle + 400 cleanup ≈ 1 s for the first strategy.
    await vi.advanceTimersByTimeAsync(6000)
    const report = await run

    expect(report.cancelled).toBe(true)
    expect(probes).toBe(1)
    expect(deps.reports.at(-1)?.cancelled).toBe(true)
  })

  it('is a no-op when no sweep is running', () => {
    expect(isStrategyTestRunning()).toBe(false)
    expect(cancelStrategyTest('user')).toBe(false)
  })
})

describe('strategy sweep resilience (B3)', () => {
  it('scores a strategy that fails to spawn as zero and continues the sweep', async () => {
    vi.useFakeTimers()
    let pid = 200
    const deps = makeDeps({
      status: () => ({ state: 'stopped' }),
      spawnStrategy: (batPath) => {
        if (batPath.endsWith('general1.bat')) throw new Error('spawn failed')
        return { pid: (pid += 1) - 1, exitCode: null }
      }
    })

    const run = runStrategyTestsWith(deps)
    // Three strategies; each successful one costs 250 spawn + 300 settle +
    // 400 cleanup. The failed one returns immediately.
    await vi.advanceTimersByTimeAsync(20_000)
    const report = await run

    // One broken strategy must not truncate the report.
    expect(Object.keys(report.results).sort()).toEqual([
      'general1.bat',
      'general2.bat',
      'general3.bat'
    ])
    expect(report.results['general1.bat']).toMatchObject({
      tested: true,
      passed: false,
      okCount: 0,
      score: 0,
      totalCount: 6
    })
    expect(report.results['general2.bat'].passed).toBe(true)
    expect(report.results['general3.bat'].passed).toBe(true)
    expect(report.cancelled).toBeUndefined()
    expect(isStrategyTestRunning()).toBe(false)
  })

  it('never truncates the report when the last strategy is broken', async () => {
    vi.useFakeTimers()
    let pid = 300
    const deps = makeDeps({
      status: () => ({ state: 'stopped' }),
      spawnStrategy: (batPath) => {
        if (batPath.endsWith('general3.bat')) throw new Error('spawn failed')
        return { pid: (pid += 1) - 1, exitCode: null }
      }
    })

    const run = runStrategyTestsWith(deps)
    await vi.advanceTimersByTimeAsync(20_000)
    const report = await run

    expect(Object.keys(report.results)).toHaveLength(3)
    expect(report.results['general3.bat'].passed).toBe(false)
    expect(report.bestStrategy).toBe('general1.bat')
  })

  it('kills a child spawned by the abort race instead of leaking it', async () => {
    vi.useFakeTimers()
    let releaseSpawn: (() => void) | null = null
    const deps = makeDeps({
      status: () => ({ state: 'stopped' }),
      strategies: () => [strategy('general1.bat')],
      spawnStrategy: () => ({ pid: 501, exitCode: null }),
      // Let the queued spawn complete, then hold the lock promise so the abort
      // lands between "child spawned" and "spawnPromise resolved".
      withZapretLock: async <T,>(fn: () => Promise<T>): Promise<T> => {
        const result = await fn()
        if (result) {
          await new Promise<void>((resolve) => {
            releaseSpawn = resolve
          })
        }
        return result
      }
    })

    const run = runStrategyTestsWith(deps)
    // 250 ms cleanup sleep happens before the spawn.
    await vi.advanceTimersByTimeAsync(300)
    expect(releaseSpawn).not.toBeNull()

    expect(cancelStrategyTest('user')).toBe(true)
    // Unblock the queued section only after the abort: `testOneStrategy` must
    // still await it and kill the child it produced.
    releaseSpawn!()
    const report = await run

    expect(report.cancelled).toBe(true)
    expect(deps.killedPids).toContain(501)
    expect(isStrategyTestRunning()).toBe(false)
  })
})

describe('upstream test semantics', () => {
  it('parses targets.txt exactly like the PowerShell parser', () => {
    const targets = parseTargets(
      [
        '# comment',
        'DiscordMain = "https://discord.com"',
        '  CloudflareDNS1111   =   "PING:1.1.1.1"  ',
        'Broken line without value',
        'Empty = ""'
      ].join('\r\n')
    )

    expect(targets).toEqual([
      { name: 'DiscordMain', url: 'https://discord.com', pingTarget: 'discord.com' },
      { name: 'CloudflareDNS1111', pingTarget: '1.1.1.1' }
    ])
  })

  it('falls back to the upstream target list when targets.txt is missing', () => {
    const targets = loadBundleTargets('C:\\does-not-exist')
    expect(targets.length).toBeGreaterThanOrEqual(16)
    expect(targets.filter((t) => t.url).length).toBe(12)
    expect(targets.filter((t) => !t.url).length).toBeGreaterThanOrEqual(4)
    expect(defaultTargets().length).toBe(targets.length)
  })

  it('classifies curl outcomes the way the script does', () => {
    expect(classifyCurl(0, '')).toBe('ok')
    expect(classifyCurl(35, '')).toBe('unsup')
    expect(classifyCurl(1, 'curl: (1) Protocol "tlsv1.3" not supported')).toBe('unsup')
    expect(classifyCurl(60, 'SSL certificate problem: self signed certificate')).toBe('ssl')
    expect(classifyCurl(28, 'Operation timed out')).toBe('error')
    expect(classifyCurl(null, 'spawn curl.exe ENOENT')).toBe('error')
  })

  it('counts HTTP OK / ERR / UNSUP and ping OK / Fail', () => {
    const summary = summarizeProbes([
      {
        name: 'Discord',
        isUrl: true,
        checks: [
          { label: 'HTTP', status: 'ok' },
          { label: 'TLS1.2', status: 'ok' },
          { label: 'TLS1.3', status: 'error' }
        ],
        ping: 'ok',
        pingMs: 12
      },
      {
        name: 'YouTube',
        isUrl: true,
        checks: [
          { label: 'HTTP', status: 'ssl' },
          { label: 'TLS1.2', status: 'unsup' },
          { label: 'TLS1.3', status: 'unsup' }
        ],
        ping: 'fail'
      },
      { name: 'DNS', isUrl: false, checks: [], ping: 'n/a' }
    ])

    expect(summary).toMatchObject({
      okCount: 2,
      errorCount: 2,
      unsupportedCount: 2,
      pingOkCount: 1,
      pingFailCount: 1,
      totalCount: 6
    })
    expect(summary.score).toBeCloseTo(2 / 6)
  })

  it('ranks by HTTP OK first and ping OK as the tie-breaker', () => {
    const result = (
      okCount: number,
      pingOkCount: number
    ): import('@main/core/zapret-tester').StrategyTestResult => ({
      tested: true,
      passed: okCount > 0,
      okCount,
      errorCount: 0,
      unsupportedCount: 0,
      pingOkCount,
      pingFailCount: 0,
      totalCount: 36,
      score: okCount / 36,
      targets: []
    })

    expect(
      chooseBestStrategy({
        'general1.bat': result(30, 16),
        'general2.bat': result(34, 4),
        'general3.bat': result(34, 12)
      })
    ).toBe('general3.bat')

    // Upstream rule: equal OK, equal ping → the first config keeps the title.
    expect(
      chooseBestStrategy({
        'general1.bat': result(10, 5),
        'general2.bat': result(10, 5)
      })
    ).toBe('general1.bat')
  })
})
