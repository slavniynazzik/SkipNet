/**
 * Persisted selections for the hosts editor.
 *
 * The catalog is immutable data; this file stores which services are enabled
 * and which DNS profile each one uses. It lives next to the rest of SkipNet's
 * user data so a catalog update never touches the user's choices.
 */

import { existsSync, readFileSync } from 'node:fs'
import { mkdir, rename, unlink, writeFile } from 'node:fs/promises'
import { randomUUID } from 'node:crypto'
import { isIP } from 'node:net'
import path from 'node:path'
import { dataDir } from '../utils/dirs'

const STATE_FILE = 'hosts-state.json'

const HOSTNAME_RE =
  /^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)(?:\.(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?))*$/i

function hasAnswers(service: HostsService, profileId: string): boolean {
  return (service.domains ?? []).some((domain) => (domain.answers[profileId]?.length ?? 0) > 0)
}

export function hostsStatePath(): string {
  return path.join(dataDir(), STATE_FILE)
}

export function defaultHostsState(catalog: HostsCatalog): HostsState {
  const profileIds = new Set(catalog.dnsProfiles.map((profile) => profile.id))
  const defaultProfile =
    (profileIds.has('geohide') && 'geohide') ||
    catalog.dnsProfiles[0]?.id ||
    ''

  const selection: Record<string, HostsSelection> = {}
  for (const service of catalog.services) selection[service.id] = 'off'

  return {
    version: 1,
    catalogVersion: catalog.meta.version,
    selection,
    defaultDnsProfile: defaultProfile,
    adobeBlock: false
  }
}

/**
 * Reconcile an arbitrary persisted state with the current catalog:
 * unknown services are ignored, new services default to off, and selections
 * that do not make sense for the service kind are normalised.
 */
export function normalizeHostsState(input: unknown, catalog: HostsCatalog): HostsState {
  const base = defaultHostsState(catalog)
  if (!input || typeof input !== 'object') return base

  const raw = input as Partial<HostsState>
  const profileIds = new Set(catalog.dnsProfiles.map((profile) => profile.id))
  const defaultProfile =
    typeof raw.defaultDnsProfile === 'string' && profileIds.has(raw.defaultDnsProfile)
      ? raw.defaultDnsProfile
      : base.defaultDnsProfile

  const selection: Record<string, HostsSelection> = {}
  for (const service of catalog.services) {
    const value = raw.selection?.[service.id]
    if (service.kind === 'hosts') {
      selection[service.id] = value === 'hosts' ? 'hosts' : 'off'
    } else {
      // A DNS service cannot use the pinned-address mode, and a profile that
      // has no answers for this service would render an empty entry set.
      const wasEnabled = typeof value === 'string' && value !== 'off'
      if (!wasEnabled) {
        selection[service.id] = 'off'
      } else if (
        typeof value === 'string' &&
        profileIds.has(value) &&
        hasAnswers(service, value)
      ) {
        selection[service.id] = value
      } else {
        const fallback = [defaultProfile, ...catalog.dnsProfiles.map((p) => p.id)].find(
          (profileId) =>
            !!profileId &&
            profileIds.has(profileId) &&
            hasAnswers(service, profileId)
        )
        selection[service.id] = fallback ?? 'off'
      }
    }
  }

  const skippedIps = Array.isArray(raw.skippedIps)
    ? [
        ...new Set(
          raw.skippedIps
            .filter((value): value is string => typeof value === 'string')
            .map((value) => value.trim())
            .filter((value) => value.length > 0 && isIP(value) !== 0)
        )
      ]
    : []

  // Verified overrides are IPv4 only: mixing A and AAAA pins makes clients
  // prefer IPv6 on networks where it is broken, which is exactly the
  // "everything hangs" symptom we are trying to remove.
  const resolvedIps: Record<string, string[]> = {}
  if (raw.resolvedIps && typeof raw.resolvedIps === 'object' && !Array.isArray(raw.resolvedIps)) {
    for (const [hostname, value] of Object.entries(raw.resolvedIps as Record<string, unknown>)) {
      const host = hostname.trim().toLowerCase()
      if (!HOSTNAME_RE.test(host) || !Array.isArray(value)) continue
      const ips = [
        ...new Set(
          value
            .filter((ip): ip is string => typeof ip === 'string')
            .map((ip) => ip.trim())
            .filter((ip) => isIP(ip) === 4)
        )
      ].slice(0, 4)
      if (ips.length > 0) resolvedIps[host] = ips
    }
  }

  const restoreSelection: Record<string, HostsSelection> = {}
  if (
    raw.restoreSelection &&
    typeof raw.restoreSelection === 'object' &&
    !Array.isArray(raw.restoreSelection)
  ) {
    for (const service of catalog.services) {
      const value = (raw.restoreSelection as Record<string, unknown>)[service.id]
      if (typeof value !== 'string' || value === 'off') continue
      if (service.kind === 'hosts') {
        if (value === 'hosts') restoreSelection[service.id] = 'hosts'
      } else if (profileIds.has(value)) {
        restoreSelection[service.id] = value
      }
    }
  }

  return {
    version: 1,
    catalogVersion: catalog.meta.version,
    selection,
    defaultDnsProfile: defaultProfile,
    adobeBlock: raw.adobeBlock === true,
    skippedIps,
    resolvedIps,
    resolvedAt: typeof raw.resolvedAt === 'string' ? raw.resolvedAt : undefined,
    restoreSelection,
    appliedAt: typeof raw.appliedAt === 'string' ? raw.appliedAt : undefined,
    renderedHash: typeof raw.renderedHash === 'string' ? raw.renderedHash : undefined
  }
}

export function loadHostsState(catalog: HostsCatalog): HostsState {
  const file = hostsStatePath()
  try {
    if (!existsSync(file)) return defaultHostsState(catalog)
    const parsed = JSON.parse(readFileSync(file, 'utf8').replace(/^\uFEFF/, '')) as unknown
    return normalizeHostsState(parsed, catalog)
  } catch (e) {
    console.warn(
      `[hosts-state] ${e instanceof Error ? e.message : String(e)} - using defaults`
    )
    return defaultHostsState(catalog)
  }
}

export async function saveHostsState(state: HostsState): Promise<void> {
  const target = hostsStatePath()
  const tmp = `${target}.${randomUUID()}.tmp`
  try {
    await mkdir(path.dirname(target), { recursive: true })
    await writeFile(tmp, `${JSON.stringify(state, null, 2)}\n`, {
      encoding: 'utf8',
      flag: 'wx'
    })
    await rename(tmp, target)
  } catch (e) {
    try {
      await unlink(tmp)
    } catch {
      /* noop */
    }
    throw new Error(
      `Не удалось сохранить настройки hosts: ${e instanceof Error ? e.message : String(e)}`
    )
  }
}
