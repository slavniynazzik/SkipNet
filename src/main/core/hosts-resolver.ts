/**
 * Live address refresh for hosts pins.
 *
 * Pinning a hostname only works while the pinned address still serves that
 * hostname. The bundled catalog is a snapshot, so addresses die and pins turn
 * into TCP timeouts. This module asks several DNS sources (the system resolver
 * plus three DoH endpoints) for current answers and then proves each candidate
 * with a real TLS handshake using the hostname as SNI.
 *
 * Only addresses that complete a handshake with a valid certificate for the
 * hostname are returned. Poisoned answers, sinkholes and addresses that break
 * under DPI fail that check and are dropped, which is exactly the behaviour we
 * want: a pin is written only when it is demonstrably better than nothing.
 */

import { promises as dns } from 'node:dns'
import { isIP } from 'node:net'
import tls from 'node:tls'

const DOH_TIMEOUT_MS = 3_500
const TLS_TIMEOUT_MS = 3_500
const HOST_CONCURRENCY = 10
const CANDIDATES_PER_HOST = 6
const KEEP_PER_HOST = 2
const MAX_HOSTS = 1_200

interface DohSource {
  id: string
  url: (hostname: string) => string
  headers?: Record<string, string>
}

const DOH_SOURCES: DohSource[] = [
  {
    id: 'google',
    url: (hostname) => `https://dns.google/resolve?name=${encodeURIComponent(hostname)}&type=A`,
    headers: { accept: 'application/dns-json' }
  },
  {
    id: 'cloudflare',
    url: (hostname) =>
      `https://cloudflare-dns.com/dns-query?name=${encodeURIComponent(hostname)}&type=A`,
    headers: { accept: 'application/dns-json' }
  },
  {
    id: 'adguard',
    url: (hostname) =>
      `https://dns.adguard-dns.com/resolve?name=${encodeURIComponent(hostname)}&type=A`,
    headers: { accept: 'application/dns-json' }
  }
]

export interface ResolveStats {
  checked: number
  resolved: number
  /** hostnames that produced at least one verified address */
  addresses: number
  /** per-source success counters, useful in the operation message */
  sources: Record<string, number>
  timedOut: boolean
  /** The caller aborted the sweep; `resolved` holds whatever was verified. */
  cancelled: boolean
}

export interface ResolveResult {
  /** hostname → up to two verified IPv4 addresses, fastest first */
  resolved: Record<string, string[]>
  stats: ResolveStats
}

/** Injectable resolution step, used by the tests instead of DoH + TLS. */
export type ResolveOneFn = (hostname: string, signal?: AbortSignal) => Promise<HostResult>

export interface ResolveOptions {
  deadlineMs?: number
  /** Cooperative cancellation: checked before each host and each TLS probe. */
  signal?: AbortSignal
  /** Test seam. */
  deps?: { resolveOne?: ResolveOneFn }
}

function isPublicIpv4(ip: string): boolean {
  if (isIP(ip) !== 4) return false
  const parts = ip.split('.').map(Number)
  if (parts.some((part) => !Number.isInteger(part) || part < 0 || part > 255)) return false
  const [a, b] = parts
  if (a === 0 || a === 10 || a === 127) return false
  if (a === 169 && b === 254) return false
  if (a === 172 && b >= 16 && b <= 31) return false
  if (a === 192 && b === 168) return false
  if (a === 100 && b >= 64 && b <= 127) return false
  if (a === 198 && (b === 18 || b === 19)) return false
  if (a >= 224) return false
  return true
}

async function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T | null> {
  let timer: NodeJS.Timeout | undefined
  try {
    return await Promise.race([
      promise,
      new Promise<null>((resolve) => {
        timer = setTimeout(() => resolve(null), ms)
      })
    ])
  } finally {
    if (timer) clearTimeout(timer)
  }
}

async function fromSystem(hostname: string): Promise<string[]> {
  try {
    const answer = await withTimeout(dns.resolve4(hostname), DOH_TIMEOUT_MS)
    return answer ?? []
  } catch {
    return []
  }
}

async function fromDoh(
  source: DohSource,
  hostname: string,
  signal?: AbortSignal
): Promise<string[]> {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), DOH_TIMEOUT_MS)
  const onAbort = (): void => controller.abort()
  signal?.addEventListener('abort', onAbort, { once: true })
  try {
    const response = await fetch(source.url(hostname), {
      headers: source.headers,
      signal: controller.signal
    })
    if (!response.ok) return []
    const text = await response.text()
    // A hostile/poisoned middlebox should not be able to feed us a huge body.
    if (text.length > 200_000) return []
    const payload = JSON.parse(text) as {
      Status?: number
      Answer?: Array<{ type?: number; data?: string }>
    }
    if (payload.Status !== 0 || !Array.isArray(payload.Answer)) return []
    return payload.Answer.filter((record) => record.type === 1 && record.data).map(
      (record) => String(record.data)
    )
  } catch {
    return []
  } finally {
    clearTimeout(timer)
    signal?.removeEventListener('abort', onAbort)
  }
}

/**
 * TLS handshake against a specific address with the hostname as SNI. Returns
 * the handshake time in milliseconds, or null when the certificate is not
 * valid for the hostname / the connection is reset.
 */
function tlsProbe(hostname: string, ip: string, signal?: AbortSignal): Promise<number | null> {
  return new Promise((resolve) => {
    // Checked before every handshake so a cancelled refresh stops opening new
    // sockets instead of running the full candidate list first.
    if (signal?.aborted) {
      resolve(null)
      return
    }
    let settled = false
    const started = Date.now()
    const socket = tls.connect({
      host: ip,
      port: 443,
      servername: hostname,
      ALPNProtocols: ['http/1.1'],
      timeout: TLS_TIMEOUT_MS
    })

    const onAbort = (): void => finish(null)
    const finish = (latency: number | null): void => {
      if (settled) return
      settled = true
      signal?.removeEventListener('abort', onAbort)
      socket.destroy()
      resolve(latency)
    }

    signal?.addEventListener('abort', onAbort, { once: true })
    socket.once('secureConnect', () => {
      finish(socket.authorized ? Date.now() - started : null)
    })
    socket.once('timeout', () => finish(null))
    socket.once('error', () => finish(null))
  })
}

interface HostResult {
  hostname: string
  ips: string[]
  sourceHits: Record<string, number>
}

async function resolveOne(hostname: string, signal?: AbortSignal): Promise<HostResult> {
  const sourceHits: Record<string, number> = {}
  if (signal?.aborted) return { hostname, ips: [], sourceHits }
  const [system, ...doh] = await Promise.all([
    fromSystem(hostname),
    ...DOH_SOURCES.map((source) => fromDoh(source, hostname, signal))
  ])

  const candidates = new Set<string>()
  const add = (id: string, ips: string[]): void => {
    const valid = ips.filter(isPublicIpv4)
    if (valid.length > 0) sourceHits[id] = valid.length
    for (const ip of valid) candidates.add(ip)
  }

  add('system', system)
  DOH_SOURCES.forEach((source, index) => add(source.id, doh[index] ?? []))

  const list = [...candidates].slice(0, CANDIDATES_PER_HOST)
  if (list.length === 0 || signal?.aborted) return { hostname, ips: [], sourceHits }

  const probed = await Promise.all(
    list.map(async (ip) => ({ ip, latency: await tlsProbe(hostname, ip, signal) }))
  )
  const verified = probed
    .filter((item): item is { ip: string; latency: number } => item.latency !== null)
    .sort((a, b) => a.latency - b.latency)
    .slice(0, KEEP_PER_HOST)
    .map((item) => item.ip)

  return { hostname, ips: verified, sourceHits }
}

/**
 * Resolve and verify addresses for the given hostnames.
 *
 * Resolution runs with a bounded pool so a large selection (hundreds of
 * hostnames) still finishes in a reasonable time without opening thousands of
 * sockets at once. `deadlineMs` and `signal` let the caller stop early and keep
 * whatever has been verified so far; the caller reports it as partial.
 */
export async function resolveHosts(
  hostnames: string[],
  options: ResolveOptions = {}
): Promise<ResolveResult> {
  const unique = [...new Set(hostnames.map((host) => host.trim().toLowerCase()))]
    .filter((host) => host.length > 0 && isIP(host) === 0)
    .slice(0, MAX_HOSTS)

  const deadline = Date.now() + (options.deadlineMs ?? 300_000)
  const signal = options.signal
  const resolve = options.deps?.resolveOne ?? resolveOne
  const resolved: Record<string, string[]> = {}
  const stats: ResolveStats = {
    checked: 0,
    resolved: 0,
    addresses: 0,
    sources: {},
    timedOut: false,
    cancelled: false
  }

  let index = 0
  const worker = async (): Promise<void> => {
    for (;;) {
      if (signal?.aborted) {
        stats.cancelled = true
        return
      }
      if (Date.now() > deadline) {
        stats.timedOut = true
        return
      }
      const current = unique[index]
      index += 1
      if (!current) return

      const result = await resolve(current, signal)
      if (signal?.aborted) {
        stats.cancelled = true
        return
      }
      stats.checked += 1
      for (const [source, hits] of Object.entries(result.sourceHits)) {
        stats.sources[source] = (stats.sources[source] ?? 0) + hits
      }
      if (result.ips.length > 0) {
        resolved[current] = result.ips
        stats.resolved += 1
        stats.addresses += result.ips.length
      }
    }
  }

  await Promise.all(
    Array.from({ length: Math.min(HOST_CONCURRENCY, unique.length) }, () => worker())
  )

  return { resolved, stats }
}
