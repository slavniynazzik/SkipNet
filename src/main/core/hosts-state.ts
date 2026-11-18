/**
 * Persisted selections for the hosts editor.
 *
 * The catalog is immutable data; this file stores which services are enabled
 * and which DNS profile each one uses. It lives next to the rest of SkipNet's
 * user data so a catalog update never touches the user's choices.
 */

import { existsSync, readFileSync } from 'node:fs'
import { mkdir, rename, unlink, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { dataDir } from '../utils/dirs'

const STATE_FILE = 'hosts-state.json'

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
    } else if (typeof value === 'string' && profileIds.has(value)) {
      selection[service.id] = value
    } else if (value === 'hosts') {
      // A DNS service cannot use the pinned-address mode. Treat the old value
      // as "enabled with the default profile" instead of silently disabling it.
      selection[service.id] = defaultProfile
    } else {
      selection[service.id] = 'off'
    }
  }

  return {
    version: 1,
    catalogVersion: catalog.meta.version,
    selection,
    defaultDnsProfile: defaultProfile,
    adobeBlock: raw.adobeBlock === true,
    appliedAt: typeof raw.appliedAt === 'string' ? raw.appliedAt : undefined,
    renderedHash: typeof raw.renderedHash === 'string' ? raw.renderedHash : undefined
  }
}

export function loadHostsState(catalog: HostsCatalog): HostsState {
  const file = hostsStatePath()
  try {
    if (!existsSync(file)) return defaultHostsState(catalog)
    const parsed = JSON.parse(readFileSync(file, 'utf8')) as unknown
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
  const tmp = `${target}.tmp`
  try {
    await mkdir(path.dirname(target), { recursive: true })
    await writeFile(tmp, `${JSON.stringify(state, null, 2)}\n`, 'utf8')
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
