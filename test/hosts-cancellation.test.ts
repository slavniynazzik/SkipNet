/**
 * C1 / audit P1-4: hosts operations must not block on the network.
 *
 * These tests cover the three properties the lock split relies on:
 *  1. cancellation — the resolver and the TCP prober stop early instead of
 *     finishing the whole list (`AbortController`, no real sleeps);
 *  2. lock ordering — a refresh that finished against a stale selection never
 *     overwrites the user's newer choice;
 *  3. lenient reads — a transiently unreadable hosts file or state file is a
 *     warning, not a broken page.
 *
 * Everything is injected: no network, no real sockets, no admin rights.
 */
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { app } from 'electron'
import { afterEach, describe, expect, it } from 'vitest'
import { clearProbeCache, probeIps, PROBE_CACHE_TTL_MS, type ProbeFn } from '@main/core/hosts-health'
import { resolveHosts } from '@main/core/hosts-resolver'
import {
  readHostsRawLenient,
  readHostsRawStrict,
  setHostsPathForTesting
} from '@main/core/hosts-file'
import { loadHostsStateRecovering } from '@main/core/hosts-state'
import {
  getHostsOverview,
  hostsStateSignature,
  mergeRefreshResult
} from '@main/core/hosts-editor'

/* -------------------------------------------------------------------------- */
/* helpers                                                                    */
/* -------------------------------------------------------------------------- */

const tempDirs: string[] = []

function tempDir(prefix: string): string {
  const dir = mkdtempSync(path.join(os.tmpdir(), prefix))
  tempDirs.push(dir)
  return dir
}

afterEach(() => {
  setHostsPathForTesting(null)
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true })
  }
})

/**
 * Point `windowsHostsPath()` at a throw-away directory so the tests never
 * touch the real system hosts file.
 */
function useTempHostsFile(): { hostsPath: string; restore: () => void } {
  const dir = tempDir('skipnet-hosts-')
  const hostsPath = path.join(dir, 'hosts')
  setHostsPathForTesting(hostsPath)
  return { hostsPath, restore: () => setHostsPathForTesting(null) }
}

function catalog(): HostsCatalog {
  return {
    meta: {
      version: 'cat-1',
      sha256: 'deadbeef',
      createdAt: '2026-01-01T00:00:00Z',
      schemaVersion: 1,
      source: 'unit-test'
    },
    dnsProfiles: [{ id: 'geo', name: 'GeoHide', order: 1 }],
    services: [
      {
        id: 'discord',
        name: 'Discord',
        category: 'other',
        kind: 'dns',
        order: 1,
        icon: '',
        domains: [
          { hostname: 'discord.com', answers: { geo: ['1.1.1.1'] } },
          { hostname: 'cdn.discord.com', answers: { geo: ['1.1.1.2'] } }
        ]
      },
      {
        id: 'youtube',
        name: 'YouTube',
        category: 'other',
        kind: 'hosts',
        order: 2,
        icon: '',
        entries: [{ hostname: 'youtube.com', ips: ['2.2.2.2'] }]
      }
    ]
  }
}

function state(overrides: Partial<HostsState> = {}): HostsState {
  return {
    version: 1,
    catalogVersion: 'cat-1',
    selection: { discord: 'geo', youtube: 'hosts' },
    defaultDnsProfile: 'geo',
    adobeBlock: false,
    ...overrides
  }
}

/* -------------------------------------------------------------------------- */
/* cancellation                                                               */
/* -------------------------------------------------------------------------- */

describe('resolveHosts cancellation', () => {
  it('stops early when the signal aborts and reports a partial result', async () => {
    const controller = new AbortController()
    const hostnames = Array.from({ length: 100 }, (_, i) => `host${i}.example`)
    let calls = 0

    const result = await resolveHosts(hostnames, {
      signal: controller.signal,
      deps: {
        resolveOne: async (hostname) => {
          calls += 1
          // Abort after the first host; the pool must notice before starting
          // any of the remaining 99 hosts.
          if (calls === 1) controller.abort()
          return { hostname, ips: [], sourceHits: {} }
        }
      }
    })

    expect(result.stats.cancelled).toBe(true)
    // 10 workers may already be in flight, but never the whole list.
    expect(calls).toBeLessThan(hostnames.length)
    expect(calls).toBeLessThanOrEqual(10)
    expect(result.stats.resolved).toBe(0)
  })

  it('keeps the run partial when a probe is aborted mid-host', async () => {
    const controller = new AbortController()
    let calls = 0
    const result = await resolveHosts(['one.example', 'two.example'], {
      signal: controller.signal,
      deps: {
        resolveOne: async (hostname) => {
          calls += 1
          // First host completes, the second aborts the sweep.
          if (calls === 2) controller.abort()
          return calls === 1
            ? { hostname, ips: ['7.7.7.7'], sourceHits: {} }
            : { hostname, ips: [], sourceHits: {} }
        }
      }
    })

    // Results produced before the abort are discarded by the cancellation
    // check, and the caller is told the run was partial.
    expect(result.stats.cancelled).toBe(true)
    expect(Object.keys(result.resolved).length).toBeLessThanOrEqual(1)
  })
})

describe('probeIps cancellation and cache', () => {
  it('stops probing after the signal aborts', async () => {
    clearProbeCache()
    const controller = new AbortController()
    const ips = Array.from({ length: 40 }, (_, i) => `203.0.113.${i + 1}`)
    let probed = 0
    const probe: ProbeFn = async () => {
      probed += 1
      if (probed === 1) controller.abort()
      return true
    }

    const result = await probeIps(ips, { probe, signal: controller.signal })

    expect(probed).toBeLessThan(ips.length)
    expect(result.size).toBe(0)
  })

  it('never touches the network with cacheOnly and a cold cache', async () => {
    clearProbeCache()
    let probed = 0
    const result = await probeIps(['198.51.100.7'], {
      cacheOnly: true,
      probe: async () => {
        probed += 1
        return true
      }
    })

    expect(probed).toBe(0)
    // "No verdict" — the caller keeps the address instead of dropping it.
    expect(result.has('198.51.100.7')).toBe(false)
  })

  it('expires a negative verdict after the visible fail TTL', async () => {
    clearProbeCache()
    const ip = '203.0.113.77'
    const failed = await probeIps([ip], { probe: async () => false, now: 1_000 })
    expect(failed.get(ip)).toBe(false)

    // Inside the TTL the cached negative verdict is reused, no probe.
    let probed = 0
    const cached = await probeIps([ip], {
      probe: async () => {
        probed += 1
        return true
      },
      now: 1_000 + PROBE_CACHE_TTL_MS.fail - 1
    })
    expect(probed).toBe(0)
    expect(cached.get(ip)).toBe(false)

    // Past the TTL the address is probed again.
    const fresh = await probeIps([ip], {
      probe: async () => true,
      now: 1_000 + PROBE_CACHE_TTL_MS.fail + 1
    })
    expect(fresh.get(ip)).toBe(true)
    clearProbeCache()
  })
})

/* -------------------------------------------------------------------------- */
/* lock ordering                                                              */
/* -------------------------------------------------------------------------- */

describe('mergeRefreshResult (stale snapshot)', () => {
  it('keeps the user selection made during the refresh and merges only current targets', () => {
    const cat = catalog()
    const snapshot = state()

    // The user turned YouTube off while the DoH probe was running.
    const current = state({ selection: { discord: 'geo', youtube: 'off' } })
    // The probe still verified both hostnames.
    const result = mergeRefreshResult({
      catalog: cat,
      current,
      snapshotSignature: hostsStateSignature(snapshot),
      resolved: {
        'discord.com': ['9.9.9.1'],
        'cdn.discord.com': ['9.9.9.2'],
        'youtube.com': ['9.9.9.3']
      },
      now: '2026-11-20T00:00:00.000Z'
    })

    expect(result.stale).toBe(true)
    // The toggle wins.
    expect(result.state.selection.youtube).toBe('off')
    // Only still-selected hostnames get the verified addresses.
    expect(result.state.resolvedIps).toEqual({
      'discord.com': ['9.9.9.1'],
      'cdn.discord.com': ['9.9.9.2']
    })
    expect(result.state.resolvedAt).toBe('2026-11-20T00:00:00.000Z')
  })

  it('applies every verified address when the selection did not change', () => {
    const cat = catalog()
    const current = state()

    const result = mergeRefreshResult({
      catalog: cat,
      current,
      snapshotSignature: hostsStateSignature(current),
      resolved: {
        'discord.com': ['9.9.9.1'],
        'cdn.discord.com': ['9.9.9.2'],
        'youtube.com': ['9.9.9.3']
      }
    })

    expect(result.stale).toBe(false)
    expect(result.state.resolvedIps).toEqual({
      'discord.com': ['9.9.9.1'],
      'cdn.discord.com': ['9.9.9.2'],
      'youtube.com': ['9.9.9.3']
    })
  })

  it('revives a service only when this refresh verified one of its hosts', () => {
    const cat = catalog()
    const current = state({
      selection: { discord: 'off', youtube: 'hosts' },
      restoreSelection: { discord: 'geo' }
    })

    const revived = mergeRefreshResult({
      catalog: cat,
      current,
      snapshotSignature: 'stale',
      resolved: { 'discord.com': ['9.9.9.1'] }
    })
    expect(revived.state.selection.discord).toBe('geo')
    expect(revived.state.restoreSelection).toEqual({})
    expect(revived.revived).toEqual(['Discord'])

    const notRevived = mergeRefreshResult({
      catalog: cat,
      current,
      snapshotSignature: 'stale',
      resolved: { 'youtube.com': ['9.9.9.3'] }
    })
    expect(notRevived.state.selection.discord).toBe('off')
    expect(notRevived.state.restoreSelection).toEqual({ discord: 'geo' })
    expect(notRevived.revived).toEqual([])
  })

  it('drops skipped IPs that the refresh just verified', () => {
    const cat = catalog()
    const current = state({ skippedIps: ['9.9.9.1', '5.5.5.5'] })
    const result = mergeRefreshResult({
      catalog: cat,
      current,
      snapshotSignature: 'stale',
      resolved: { 'discord.com': ['9.9.9.1'] }
    })
    expect(result.state.skippedIps).toEqual(['5.5.5.5'])
  })
})

/* -------------------------------------------------------------------------- */
/* lenient reads                                                              */
/* -------------------------------------------------------------------------- */

describe('lenient hosts read', () => {
  it('returns the bytes for a readable file and an empty result for a missing one', () => {
    const root = useTempHostsFile()
    try {
      expect(readHostsRawLenient()).toEqual({ content: '', ok: true })
      writeFileSync(root.hostsPath, '127.0.0.1 localhost\r\n', 'latin1')
      expect(readHostsRawLenient()).toMatchObject({ ok: true })
      expect(readHostsRawLenient().content).toBe('127.0.0.1 localhost\r\n')
    } finally {
      root.restore()
    }
  })

  it('reports an unreadable file as a warning instead of throwing', () => {
    const root = useTempHostsFile()
    try {
      // A directory at the hosts path makes readFileSync fail with EISDIR /
      // EPERM on Windows — the same class of error AV/EBUSY produces.
      mkdirSync(root.hostsPath)
      const read = readHostsRawLenient()
      expect(read.ok).toBe(false)
      expect(read.content).toBe('')
      expect(read.error).toBeTruthy()
      // Mutations still fail closed.
      expect(() => readHostsRawStrict()).toThrow()
    } finally {
      root.restore()
    }
  })

  it('renders the overview with a warning when hosts cannot be read', async () => {
    const appResources = path.join(app.getAppPath(), 'resources')
    mkdirSync(appResources, { recursive: true })
    writeFileSync(
      path.join(appResources, 'hosts-catalog.json'),
      JSON.stringify(catalog()),
      'utf8'
    )

    const root = useTempHostsFile()
    try {
      mkdirSync(root.hostsPath)
      const overview = await getHostsOverview()
      expect(overview.status.readWarning).toContain('hosts')
      expect(overview.status.readWarning).toContain('Не удалось прочитать файл hosts')
      expect(overview.status.enabledServices).toBe(0)
    } finally {
      root.restore()
    }
  })
})

describe('loadHostsStateRecovering (transient lock)', () => {
  it('does not rename a good state file when the read fails with EBUSY', async () => {
    const { hostsStatePath, defaultHostsState } = await import('@main/core/hosts-state')
    const file = hostsStatePath()
    mkdirSync(path.dirname(file), { recursive: true })
    const good = JSON.stringify({ selection: { discord: 'geo' } })
    writeFileSync(file, good, 'utf8')

    const result = await loadHostsStateRecovering(catalog(), {
      readText: () => {
        const error = new Error('The process cannot access the file') as NodeJS.ErrnoException
        error.code = 'EBUSY'
        throw error
      }
    })

    expect(result.recovery).toBeUndefined()
    expect(result.readWarning).toContain('занят другим процессом')
    expect(result.state).toEqual(defaultHostsState(catalog()))
    // The file is untouched, so the next read still sees the real selection.
    expect(readFileSync(file, 'utf8')).toBe(good)
    rmSync(file, { force: true })
  })
})
