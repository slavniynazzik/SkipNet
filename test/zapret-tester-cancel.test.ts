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
  isStrategyTestRunning,
  runStrategyTestsWith,
  type StrategyTesterDeps,
  type StrategyTestReport,
  type TestProgress
} from '@main/core/zapret-tester'
import type { StrategyDescriptor } from '@main/core/zapret'

function okResults(): Array<{ url: string; ok: boolean; ms: number }> {
  return Array.from({ length: 4 }, (_, i) => ({ url: `https://t${i}.test`, ok: true, ms: 1 }))
}

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
    // Reach the first strategy's warm-up (spawn boundary 250 ms, boot instant).
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
    // 250 spawn + 4500 warm-up + 400 cleanup = ~5.2 s for the first strategy.
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
