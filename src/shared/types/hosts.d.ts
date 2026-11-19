/**
 * Types for the service catalog behind the "Редактор hosts" page.
 *
 * The catalog is generated from ZapretGUI's hosts_catalog.sqlite3 by
 * `scripts/import-hosts-catalog.py`. It intentionally contains only the
 * service/domain/IP data needed to render hosts entries - no UI state.
 */

interface HostsCatalogMeta {
  version: string
  sha256: string
  createdAt: string
  checkedAt?: string
  schemaVersion: number
  source: string
}

interface HostsDnsProfile {
  id: string
  name: string
  order: number
}

interface HostsHostEntry {
  hostname: string
  ips: string[]
}

interface HostsDomainAnswer {
  hostname: string
  /** profile id → ordered list of IPs */
  answers: Record<string, string[]>
}

interface HostsService {
  id: string
  name: string
  category: 'direct' | 'ai' | 'other'
  kind: 'hosts' | 'dns'
  order: number
  icon: string
  color?: string | null
  /** Present when kind === 'hosts'. */
  entries?: HostsHostEntry[]
  /** Present when kind === 'dns'. */
  domains?: HostsDomainAnswer[]
}

interface HostsCatalog {
  meta: HostsCatalogMeta
  dnsProfiles: HostsDnsProfile[]
  services: HostsService[]
}

/** `off`, the pinned `hosts` mode, or a DNS profile id. */
type HostsSelection = 'off' | 'hosts' | string

interface HostsState {
  version: 1
  catalogVersion: string
  /** service id → mode/profile/off */
  selection: Record<string, HostsSelection>
  defaultDnsProfile: string
  adobeBlock: boolean
  /**
   * Addresses that failed the reachability probe at the last apply. They stay
   * out of the managed block until a later probe succeeds.
   */
  skippedIps?: string[]
  /**
   * hostname → verified addresses found by the DoH refresh. When present for a
   * hostname, these replace the addresses frozen in the catalog, which is what
   * keeps pins alive across catalog snapshots.
   */
  resolvedIps?: Record<string, string[]>
  /** ISO timestamp of the last DoH refresh. */
  resolvedAt?: string
  /**
   * service id → the selection that was active before the health check turned
   * it off. Kept so a later DoH refresh can bring the service back instead of
   * losing the user's profile choice.
   */
  restoreSelection?: Record<string, HostsSelection>
  appliedAt?: string
  renderedHash?: string
}

interface HostsLegacyBlocks {
  zapretGui: boolean
  skipNet: boolean
  adobe: boolean
}

/**
 * Present when `hosts-state.json` could not be parsed and was rebuilt from the
 * managed block in the system hosts file (C4). The corrupt file is retained
 * next to the profile so the user can inspect it.
 */
interface HostsStateRecovery {
  recovered: boolean
  warning?: string
  corruptPath?: string
}

interface HostsFileStatus {
  path: string
  exists: boolean
  writable: boolean
  /** Lines currently owned by the SkipNet editor block. */
  managedLines: number
  /** Services counted as enabled in the state. */
  enabledServices: number
  /** Number of entries in the Adobe activation block list. */
  adobeEntries: number
  appliedAt?: string
  /** True when the file no longer matches the last written state. */
  externalChange: boolean
  /** True when the catalog/state would render a different managed block. */
  needsReapply: boolean
  legacy: HostsLegacyBlocks
  recovery?: HostsStateRecovery
  /**
   * Set when the page could be rendered but the file/state could not be read
   * this time (EPERM/EBUSY from AV or an indexer). The saved settings are
   * shown instead of failing the whole page.
   */
  readWarning?: string
}

interface HostsOverview {
  catalog: HostsCatalog
  catalogSource: 'bundled' | 'downloaded'
  state: HostsState
  status: HostsFileStatus
  recovery?: HostsStateRecovery
}

interface HostsOperationResult extends HostsOverview {
  message: string
  warnings: string[]
}

interface HostsCatalogUpdateResult {
  version: string
  updated: boolean
  source: 'bundled' | 'downloaded'
}

