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
 */

import net, { isIP } from 'node:net'

const OK_TTL_MS = 10 * 60_000
const FAIL_TTL_MS = 2 * 60_000
const DEFAULT_TIMEOUT_MS = 2_000
const CONCURRENCY = 8

const cache = new Map<string, { ok: boolean; at: number }>()

function isLocalAddress(ip: string): boolean {
  return (
    ip === '127.0.0.1' ||
    ip === '::1' ||
    ip === '0.0.0.0' ||
    ip.toLowerCase() === 'localhost'
  )
}

function probeOne(ip: string, port: number, timeoutMs: number): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = new net.Socket()
    let settled = false
    const finish = (ok: boolean): void => {
      if (settled) return
      settled = true
      socket.destroy()
      resolve(ok)
    }
    socket.setTimeout(timeoutMs)
    socket.once('connect', () => finish(true))
    socket.once('timeout', () => finish(false))
    socket.once('error', () => finish(false))
    try {
      socket.connect(port, ip)
    } catch {
      finish(false)
    }
  })
}

/**
 * Probe the given addresses in parallel and return `ip → reachable`.
 * Invalid addresses and loopback entries are reported as reachable so they
 * are never filtered out.
 */
export async function probeIps(
  ips: string[],
  options: { port?: number; timeoutMs?: number; force?: boolean } = {}
): Promise<Map<string, boolean>> {
  const port = options.port ?? 443
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS
  const result = new Map<string, boolean>()
  const pending: string[] = []
  const now = Date.now()

  for (const raw of new Set(ips)) {
    const ip = raw.trim()
    if (!ip || isLocalAddress(ip) || isIP(ip) === 0) {
      result.set(ip, true)
      continue
    }
    const cached = options.force ? undefined : cache.get(ip)
    if (cached) {
      const ttl = cached.ok ? OK_TTL_MS : FAIL_TTL_MS
      if (now - cached.at < ttl) {
        result.set(ip, cached.ok)
        continue
      }
    }
    pending.push(ip)
  }

  let index = 0
  const worker = async (): Promise<void> => {
    for (;;) {
      const current = pending[index]
      index += 1
      if (!current) return
      const ok = await probeOne(current, port, timeoutMs)
      cache.set(current, { ok, at: Date.now() })
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
