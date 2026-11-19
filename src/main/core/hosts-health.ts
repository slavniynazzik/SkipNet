/**
 * Reachability probe for hosts pins.
 *
 * A hosts entry is only useful while the pinned address still serves the
 * domain. The catalog is a snapshot, so an address can be dead months later
 * (a retired CDN edge or a closed bypass endpoint). Writing such an address is
 * worse than writing nothing: the client tries it first, waits for the TCP
 * timeout and only then falls back, which is exactly what "everything loads
 * slowly" looks like.
 *
 * We therefore probe the addresses we are about to write and skip the ones
 * that do not accept a TCP connection on 443. Results are cached so repeated
 * toggles stay fast.
 *
 * The cache is the reason toggles no longer have to block: `cacheOnly: true`
 * answers from the cache alone and reports "unknown" for addresses that were
 * never probed, so the toggle can apply immediately and the regular
 * «Проверить адреса»/DoH refresh does the filtering later.
 */

import net, { isIP } from 'node:net'

/**
 * Cache lifetimes, exported so callers (and the tests) can reason about the
 * same numbers instead of duplicating them.
 */
export const PROBE_CACHE_TTL_MS = Object.freeze({
  ok: 10 * 60_000,
  fail: 2 * 60_000
})

const DEFAULT_TIMEOUT_MS = 2_000
const CONCURRENCY = 8

/** Injectable for tests: no real socket, no real 2 s timeouts. */
export type ProbeFn = (
  ip: string,
  port: number,
  timeoutMs: number,
  signal?: AbortSignal
) => Promise<boolean>

const cache = new Map<string, { ok: boolean; at: number }>()

function isLocalAddress(ip: string): boolean {
  return (
    ip === '127.0.0.1' ||
    ip === '::1' ||
    ip === '0.0.0.0' ||
    ip.toLowerCase() === 'localhost'
  )
}

function probeOne(
  ip: string,
  port: number,
  timeoutMs: number,
  signal?: AbortSignal
): Promise<boolean> {
  return new Promise((resolve) => {
    if (signal?.aborted) {
      resolve(false)
      return
    }
    const socket = new net.Socket()
    let settled = false
    const onAbort = (): void => finish(false)
    const finish = (ok: boolean): void => {
      if (settled) return
      settled = true
      signal?.removeEventListener('abort', onAbort)
      socket.destroy()
      resolve(ok)
    }
    socket.setTimeout(timeoutMs)
    socket.once('connect', () => finish(true))
    socket.once('timeout', () => finish(false))
    socket.once('error', () => finish(false))
    signal?.addEventListener('abort', onAbort, { once: true })
    try {
      socket.connect(port, ip)
    } catch {
      finish(false)
    }
  })
}

export interface ProbeOptions {
  port?: number
  timeoutMs?: number
  /** Ignore cached verdicts and probe again (explicit «Проверить адреса»). */
  force?: boolean
  /**
   * Never touch the network: return only verdicts that are already cached.
   * Addresses with no cached verdict are omitted, so callers can treat them
   * as "unknown, keep" instead of "dead, skip".
   */
  cacheOnly?: boolean
  /** Cooperative cancellation checked before every probe. */
  signal?: AbortSignal
  /** Test seam. */
  probe?: ProbeFn
  /** Test seam for cache expiry. */
  now?: number
}

/**
 * Probe the given addresses in parallel and return `ip → reachable`.
 * Invalid addresses and loopback entries are reported as reachable so they
 * are never filtered out.
 *
 * A missing entry means "no verdict": either `cacheOnly` had nothing cached,
 * or the caller aborted before the address was probed. Aborted probes are
 * never written to the cache — an aborted attempt is not a verdict.
 */
export async function probeIps(
  ips: string[],
  options: ProbeOptions = {}
): Promise<Map<string, boolean>> {
  const port = options.port ?? 443
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS
  const probe = options.probe ?? probeOne
  const now = options.now ?? Date.now()
  const result = new Map<string, boolean>()
  const pending: string[] = []

  for (const raw of new Set(ips)) {
    const ip = raw.trim()
    if (!ip || isLocalAddress(ip) || isIP(ip) === 0) {
      result.set(ip, true)
      continue
    }
    const cached = options.force ? undefined : cache.get(ip)
    if (cached) {
      const ttl = cached.ok ? PROBE_CACHE_TTL_MS.ok : PROBE_CACHE_TTL_MS.fail
      if (now - cached.at < ttl) {
        result.set(ip, cached.ok)
        continue
      }
    }
    // Cold cache + cacheOnly: report nothing rather than probing.
    if (options.cacheOnly) continue
    pending.push(ip)
  }

  if (options.signal?.aborted) return result

  let index = 0
  const worker = async (): Promise<void> => {
    for (;;) {
      if (options.signal?.aborted) return
      const current = pending[index]
      index += 1
      if (!current) return
      const ok = await probe(current, port, timeoutMs, options.signal)
      // Do not cache a result produced by an aborted probe.
      if (options.signal?.aborted) return
      cache.set(current, { ok, at: options.now ?? Date.now() })
      result.set(current, ok)
    }
  }

  await Promise.all(
    Array.from({ length: Math.min(CONCURRENCY, pending.length) }, () => worker())
  )
  return result
}

/** Drop cached verdicts (used after the user edits hosts or updates catalog). */
export function clearProbeCache(): void {
  cache.clear()
}
