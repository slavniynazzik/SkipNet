/**
 * Hosts editor orchestration: catalog + state + the Windows hosts file.
 *
 * Lock model (C1, audit P1-4):
 *
 *  - `withStateLock` is the only lock. It is held for short
 *    read-modify-write cycles: reading `hosts-state.json` and the managed
 *    block, creating a backup, writing the file, verifying it and rolling
 *    back. Nothing that talks to the network runs inside it.
 *  - Probes (`probeIps`, `resolveHosts`, DoH, TLS) run *outside* the lock
 *    against an immutable snapshot of the state. `getHostsOverview` therefore
 *    never waits for a probe — only for a write that is already running.
 *  - `refreshHostsAddresses` snapshots, releases the lock, probes with a
 *    cancellation signal, then re-acquires the lock and merges. If the
 *    selection changed in the meantime the user's change wins and only
 *    verified addresses for hostnames that are still selected are merged.
 *
 * Safety guarantees are unchanged: every mutation writes a backup first,
 * persists state before touching hosts, re-reads and hash-verifies the file
 * and rolls back on any mismatch.
 */

import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  unlinkSync,
  writeFileSync
} from 'node:fs'
import path from 'node:path'
import { createHash, randomUUID } from 'node:crypto'
import { shell, app } from 'electron'
import { dataDir, resourcesDir } from '../utils/dirs'
import { appLog } from '../utils/app-logger'
import {
  flushDns,
  hostsFileWritable,
  readHostsRawLenient,
  readHostsRawStrict,
  windowsHostsPath,
  writeHostsContent,
  type DnsFlushResult
} from './hosts-file'
import {
  getHostsCatalog,
  getDnsProfileName,
  invalidateHostsCatalogCache,
  updateHostsCatalog
} from './hosts-catalog'
import {
  defaultHostsState,
  loadHostsState,
  loadHostsStateRecovering,
  normalizeHostsState,
  saveHostsState
} from './hosts-state'
import {
  assertBalancedBlocks,
  buildHostsContent,
  countEditorBlockLines,
  countLegacyUnknownHostnames,
  detectLegacyBlocks,
  effectiveEntryIps,
  extractBlock,
  hashHostsContent,
  importLegacySelection,
  parseAdobeEntries,
  parseEditorBlock,
  parseLegacySkipNet,
  parseLegacyZapretGui,
  renderAdobeBlock,
  renderManagedBlock,
  selectedEntries,
  validateHostsFileContent,
  ADOBE_BLOCK_END,
  ADOBE_BLOCK_START,
  EDITOR_BLOCK_END,
  EDITOR_BLOCK_START,
  type RenderedHostsBlock
} from './hosts-render'
import { probeIps } from './hosts-health'
import { resolveHosts, type ResolveResult } from './hosts-resolver'

const BACKUPS_DIR = 'hosts-backups'
const MAX_BACKUPS = 20
/** Hard ceiling for one DoH refresh; partial results are still merged. */
const REFRESH_DEADLINE_MS = 120_000

const HOSTNAME_RE =
  /^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)(?:\.(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?))*$/i

function serviceHasAnswers(service: HostsService, profileId: string): boolean {
  return (service.domains ?? []).some((domain) => (domain.answers[profileId]?.length ?? 0) > 0)
}

let stateQueue: Promise<void> = Promise.resolve()

/**
 * Serialise short read-modify-write cycles on `hosts-state.json` and the
 * system hosts file. Probes must never run inside this lock: the audit found
 * the page blocking for minutes because DoH/TLS and `ipconfig` were held here.
 */
function withStateLock<T>(fn: () => Promise<T>): Promise<T> {
  const next = stateQueue.then(fn, fn)
  stateQueue = next.then(() => void 0, () => void 0)
  return next
}

/** The refresh currently in flight; a newer refresh aborts it. */
let refreshController: AbortController | null = null

interface AdobeData {
  hosts: string[]
  set: Set<string>
}

let adobeCache: AdobeData | null = null

/** The Adobe activation block list is a static resource file. */
function adobeData(): AdobeData {
  if (adobeCache) return adobeCache
  const file = path.join(resourcesDir(), 'adobe-activation-hosts.json')
  try {
    const parsed = JSON.parse(readFileSync(file, 'utf8').replace(/^\uFEFF/, '')) as unknown
    const hosts = Array.isArray(parsed)
      ? [
          ...new Set(
            parsed
              .filter((value): value is string => typeof value === 'string')
              .map((value) => value.trim().toLowerCase())
              .filter((value) => HOSTNAME_RE.test(value))
          )
        ]
      : []
    adobeCache = { hosts, set: new Set(hosts) }
  } catch (e) {
    console.warn(
      `[hosts-editor] Adobe list not available: ${e instanceof Error ? e.message : String(e)}`
    )
    adobeCache = { hosts: [], set: new Set() }
  }
  return adobeCache
}

function backupsDir(): string {
  return path.join(dataDir(), BACKUPS_DIR)
}

function nowStamp(): string {
  return new Date().toISOString().replace(/[:.]/g, '-')
}

function createBackup(content: string, state: HostsState): void {
  try {
    const dir = backupsDir()
    mkdirSync(dir, { recursive: true })
    const stamp = `${nowStamp()}-${randomUUID().slice(0, 8)}`
    writeFileSync(path.join(dir, `hosts-${stamp}.bak`), Buffer.from(content, 'latin1'), {
      flag: 'wx'
    })
    writeFileSync(
      path.join(dir, `state-${stamp}.json`),
      `${JSON.stringify(state, null, 2)}\n`,
      { encoding: 'utf8', flag: 'wx' }
    )

    const hostsFiles = readdirSync(dir)
      .filter((file) => /^hosts-.*\.bak$/.test(file))
      .sort()
      .reverse()
    for (const old of hostsFiles.slice(MAX_BACKUPS)) {
      const oldStamp = old.replace(/^hosts-/, '').replace(/\.bak$/, '')
      try {
        unlinkSync(path.join(dir, old))
      } catch {
        /* noop */
      }
      try {
        unlinkSync(path.join(dir, `state-${oldStamp}.json`))
      } catch {
        /* noop */
      }
    }
  } catch (e) {
    // A missing backup must never block the actual update.
    console.warn(
      `[hosts-editor] backup failed: ${e instanceof Error ? e.message : String(e)}`
    )
  }
}

function latestBackup(): { content: string; state: HostsState | null } | null {
  const dir = backupsDir()
  try {
    if (!existsSync(dir)) return null
    const hostsFiles = readdirSync(dir)
      .filter((file) => /^hosts-.*\.bak$/.test(file))
      .sort()
      .reverse()
    if (hostsFiles.length === 0) return null
    const file = hostsFiles[0]
    const stamp = file.replace(/^hosts-/, '').replace(/\.bak$/, '')
    const content = readFileSync(path.join(dir, file)).toString('latin1')
    let state: HostsState | null = null
    try {
      const stateFile = path.join(dir, `state-${stamp}.json`)
      if (existsSync(stateFile)) {
        state = JSON.parse(
          readFileSync(stateFile, 'utf8').replace(/^\uFEFF/, '')
        ) as HostsState
      }
    } catch {
      state = null
    }
    return { content, state }
  } catch {
    return null
  }
}

function buildStatus(
  content: string,
  state: HostsState,
  catalog: HostsCatalog
): HostsFileStatus {
  assertBalancedBlocks(content)
  const { hosts } = adobeData()
  const adobeSet = new Set(hosts)
  const legacy = detectLegacyBlocks(content, adobeSet)
  const enabled = Object.values(state.selection).filter((value) => value !== 'off').length

  const normalize = (value: string): string => value.replace(/\r\n|\r/g, '\n')
  const expectedManaged = normalize(renderManagedBlock(catalog, state).content)
  const currentManaged = extractBlock(content, EDITOR_BLOCK_START, EDITOR_BLOCK_END)
  const expectedAdobe = state.adobeBlock ? normalize(renderAdobeBlock(hosts)) : ''
  const currentAdobe = extractBlock(content, ADOBE_BLOCK_START, ADOBE_BLOCK_END)

  return {
    path: windowsHostsPath(),
    exists: existsSync(windowsHostsPath()),
    writable: hostsFileWritable(),
    managedLines: countEditorBlockLines(content),
    enabledServices: enabled,
    adobeEntries: hosts.length,
    appliedAt: state.appliedAt,
    externalChange:
      !!state.renderedHash && hashHostsContent(content) !== state.renderedHash,
    needsReapply: expectedManaged !== currentManaged || expectedAdobe !== currentAdobe,
    legacy
  }
}

interface OverviewExtras {
  recovery?: HostsStateRecovery
  readWarning?: string
}

/**
 * Build the page payload from bytes the caller already has. Read-only callers
 * pass a lenient read (a transient lock becomes a warning); mutations pass the
 * bytes they just verified.
 */
function overviewFrom(
  catalog: HostsCatalog,
  source: 'bundled' | 'downloaded',
  state: HostsState,
  content: string,
  extras: OverviewExtras = {}
): HostsOverview {
  const status: HostsFileStatus = buildStatus(content, state, catalog)
  const recovery = extras.recovery
  const readWarning = extras.readWarning
  if (recovery) status.recovery = recovery
  if (readWarning) status.readWarning = readWarning
  return {
    catalog,
    catalogSource: source,
    state,
    status,
    ...(recovery ? { recovery } : {})
  }
}

/**
 * Persisted state plus one safety correction: if the file already contains an
 * Adobe block, keep it enabled instead of deleting it on the first unrelated
 * toggle. A new install has no such block and stays off by default.
 *
 * Also the single place where a corrupt `hosts-state.json` is repaired: the
 * recovery reads the current hosts block, so both callers share one read.
 */
async function loadEffectiveState(
  catalog: HostsCatalog,
  content: string | undefined
): Promise<{ state: HostsState; recovery?: HostsStateRecovery; readWarning?: string }> {
  const loaded = await loadHostsStateRecovering(catalog, {
    ...(content === undefined ? {} : { hostsContent: content })
  })
  const state = loaded.state
  const legacy = detectLegacyBlocks(content ?? '', adobeData().set)
  let next = state

  // Only recover selections from the file when there is no applied state.
  // Once `renderedHash` exists the user's saved selection is authoritative;
  // the external-change banner handles a mismatch instead of re-enabling a
  // service the user explicitly turned off.
  const firstApply = !state.renderedHash
  if (firstApply && content) {
    const importedFromFile = importLegacySelection(
      catalog,
      [...parseEditorBlock(content), ...(legacy.skipNet ? parseLegacySkipNet(content) : [])],
      state.defaultDnsProfile
    )
    if (Object.keys(importedFromFile).length > 0) {
      next = { ...next, selection: { ...next.selection, ...importedFromFile } }
    }
  }
  if (legacy.adobe && !next.adobeBlock) next = { ...next, adobeBlock: true }
  return {
    state: next,
    recovery: loaded.recovery,
    readWarning: loaded.readWarning
  }
}

/**
 * Page load. Waits only for a write that is already in progress — never for a
 * probe. A transient EPERM/EBUSY on either file renders the saved selection
 * with a warning banner instead of failing the whole page.
 */
export function getHostsOverview(): Promise<HostsOverview> {
  return withStateLock(async () => {
    const { catalog, source } = getHostsCatalog()
    const read = readHostsRawLenient()
    const { state, recovery, readWarning } = await loadEffectiveState(
      catalog,
      read.ok ? read.content : undefined
    )
    const warnings: string[] = []
    if (readWarning) warnings.push(readWarning)
    if (!read.ok) {
      warnings.push(
        `Не удалось прочитать файл hosts (${read.error ?? 'неизвестная ошибка'}). ` +
          'Показаны сохранённые настройки; запись будет недоступна до устранения блокировки.'
      )
    }
    if (warnings.length > 0) appLog('warn', `hosts: ${warnings.join(' ')}`)
    return overviewFrom(catalog, source, state, read.content, {
      recovery,
      readWarning: warnings.length > 0 ? warnings.join(' ') : undefined
    })
  })
}

interface ApplyOutcome {
  state: HostsState
  /** Bytes of the file after the operation (or the original when unchanged). */
  content: string
  managed: RenderedHostsBlock
  changed: boolean
  warnings: string[]
  recovery?: HostsStateRecovery
}

/** Probe strategy for one apply. */
type ProbeMode =
  /** Do not probe at all (addresses were verified by the caller). */
  | 'off'
  /** Answer from the probe cache only — never waits for the network. */
  | 'cache'
  /** Full probe, ignoring the cache (explicit «Проверить адреса»). */
  | 'fresh'

function serviceSelection(service: HostsService, state: HostsState): string | null {
  const value = state.selection[service.id]
  if (!value || value === 'off') return null
  if (service.kind === 'hosts') return value === 'hosts' ? 'hosts' : null
  return value === 'hosts' ? state.defaultDnsProfile || null : value
}

/**
 * Probe the addresses the current selection would write and drop the dead
 * ones. A service whose every address is unreachable is switched off: keeping
 * it enabled would only produce TCP timeouts and a "hosts is broken" feeling.
 *
 * Modes exist so a toggle never waits for a probe:
 *  - `off`   — already verified (DoH refresh), do not probe twice.
 *  - `cache` — use cached verdicts only; a cold cache means "apply as is" and
 *              the next explicit check filters the dead pins.
 *  - `fresh` — full probe with `force`, used by «Проверить адреса».
 */
async function planReachableState(
  catalog: HostsCatalog,
  state: HostsState,
  mode: ProbeMode
): Promise<{ state: HostsState; warnings: string[] }> {
  if (mode === 'off') return { state, warnings: [] }

  const cacheOnly = mode === 'cache'
  const force = mode === 'fresh'
  const selectionOf = (service: HostsService): string | null => serviceSelection(service, state)

  const perService: Array<{ service: HostsService; ips: string[] }> = []
  const all = new Set<string>()
  for (const service of catalog.services) {
    const selection = selectionOf(service)
    if (!selection) continue
    const ips = [
      ...new Set(
        selectedEntries(service, selection).flatMap((entry) =>
          effectiveEntryIps(state, entry.hostname, entry.ips)
        )
      )
    ]
    if (ips.length === 0) continue
    perService.push({ service, ips })
    for (const ip of ips) all.add(ip)
  }

  if (all.size === 0) {
    return { state: { ...state, skippedIps: [] }, warnings: [] }
  }

  // Distinguish "the pins are dead" from "this machine has no internet at
  // all". Without a control a transient outage would switch every service off.
  // With a cold cache the controls are simply unknown and nothing is disabled.
  const control = await probeIps(['1.1.1.1', '8.8.8.8'], { cacheOnly, force })
  const controlVerdicts = [...control.values()]
  if (controlVerdicts.length > 0 && !controlVerdicts.some(Boolean)) {
    return {
      state,
      warnings: [
        'Не удалось проверить адреса: нет доступа в интернет. Настройки не изменены.'
      ]
    }
  }

  const reachable = await probeIps([...all], { cacheOnly, force })
  // Unknown verdicts (cold cache in `cache` mode) keep the previous decision:
  // a toggle must never re-introduce an address that was already proven dead.
  const previouslySkipped = new Set((state.skippedIps ?? []).map((ip) => ip.toLowerCase()))
  const skipped = [...all].filter((ip) => {
    const verdict = reachable.get(ip)
    if (verdict === undefined) return previouslySkipped.has(ip.toLowerCase())
    return verdict === false
  })
  const skippedSet = new Set(skipped)
  const selection = { ...state.selection }
  const restoreSelection = { ...(state.restoreSelection ?? {}) }
  const disabled: string[] = []

  for (const item of perService) {
    const alive = item.ips.filter((ip) => !skippedSet.has(ip)).length
    if (alive === 0) {
      const previous = selection[item.service.id]
      if (previous && previous !== 'off') restoreSelection[item.service.id] = previous
      selection[item.service.id] = 'off'
      disabled.push(item.service.name)
    } else {
      delete restoreSelection[item.service.id]
    }
  }

  // Forget restoration hints for services that no longer exist or are on.
  for (const id of Object.keys(restoreSelection)) {
    if (!catalog.services.some((service) => service.id === id) || selection[id] !== 'off') {
      delete restoreSelection[id]
    }
  }

  const warnings: string[] = []
  if (disabled.length > 0) {
    const listed = disabled.slice(0, 3).join(', ')
    const rest = disabled.length > 3 ? ` и ещё ${disabled.length - 3}` : ''
    warnings.push(
      `Адреса недоступны: ${listed}${rest}. Эти сервисы выключены — ` +
        'нажмите «Обновить адреса (DoH)», чтобы подобрать живые, или выберите другой DNS-профиль.'
    )
  }

  return { state: { ...state, selection, restoreSelection, skippedIps: skipped }, warnings }
}

async function applyCandidate(
  catalog: HostsCatalog,
  candidate: HostsState,
  options: {
    allowLegacy?: boolean
    probe?: ProbeMode
    recovery?: HostsStateRecovery
  } = {}
): Promise<ApplyOutcome> {
  const original = readHostsRawStrict()
  const previousState = loadHostsState(catalog)
  const adobe = adobeData()
  // Never silently replace an existing ZapretGUI block: the user must import
  // its services first, otherwise all its entries would disappear.
  const legacy = detectLegacyBlocks(original, adobe.set)
  if (!options.allowLegacy && (legacy.zapretGui || legacy.skipNet)) {
    throw new Error(
      'В файле hosts найден старый блок SkipNet или ZapretGUI. ' +
        'Сначала импортируйте его на этой странице.'
    )
  }

  // Health check happens before rendering so dead pins never reach the file.
  const planned = await planReachableState(catalog, candidate, options.probe ?? 'cache')
  const effective = planned.state
  const managed = renderManagedBlock(catalog, effective)
  const adobeBlock = renderAdobeBlock(adobe.hosts)
  const nextContent = buildHostsContent(
    original,
    managed,
    adobeBlock,
    effective.adobeBlock,
    adobe.set
  )
  const nextHash = hashHostsContent(nextContent)
  const changed = nextHash !== hashHostsContent(original)

  const finalState: HostsState = {
    ...effective,
    catalogVersion: catalog.meta.version,
    selection: { ...effective.selection },
    appliedAt: new Date().toISOString(),
    renderedHash: nextHash
  }

  const recovery = options.recovery

  if (!changed) {
    await saveHostsState(finalState)
    return {
      state: finalState,
      content: original,
      managed,
      changed: false,
      warnings: planned.warnings,
      recovery
    }
  }

  createBackup(original, previousState)

  // Persist the new state *before* touching the hosts file. The backup above
  // already captured the previous state, so a failed state write aborts here
  // with hosts untouched; the reverse order (write hosts, then rename state)
  // could leave the file modified while the UI still showed the old selection
  // whenever AV held hosts-state.json open.
  await saveHostsState(finalState)

  const restoreState = async (): Promise<void> => {
    try {
      await saveHostsState(previousState)
    } catch {
      /* the hosts rollback below is what the user actually sees */
    }
  }

  const written = writeHostsContent(nextContent)
  if (!written.ok) {
    // A failed direct write can leave the system file truncated before the
    // elevated fallback runs. Always put the original bytes back.
    const rollback = writeHostsContent(original)
    await restoreState()
    throw new Error(
      `Не удалось записать файл hosts: ${written.error ?? 'неизвестная ошибка'}. ` +
        (rollback.ok
          ? 'Исходный файл восстановлен.'
          : 'Автоматическое восстановление не удалось — используйте бэкап в папке hosts-backups.')
    )
  }

  const verify = readHostsRawStrict()
  if (hashHostsContent(verify) !== nextHash) {
    const rollback = writeHostsContent(original)
    await restoreState()
    throw new Error(
      'Файл hosts записан, но проверка не совпала. ' +
        (rollback.ok ? 'Исходный файл восстановлен.' : 'Автоматический откат не удался.')
    )
  }

  return {
    state: finalState,
    content: verify,
    managed,
    changed: true,
    warnings: planned.warnings,
    recovery
  }
}

/**
 * Flush the DNS cache *after* the state lock has been released.
 *
 * Deliberately not awaited: `ipconfig` can take seconds and the toggle/IPC call
 * must answer immediately once hosts is written. A failure is surfaced in the
 * Logs page instead of turning a successful apply into an error.
 */
function scheduleDnsFlush(result: HostsOperationResult, changed: boolean): HostsOperationResult {
  if (!changed) return result
  void flushDns()
    .then((flush) => {
      if (!flush.ok) appLog('warn', `hosts: DNS-кэш не очищен — ${flush.message}`)
    })
    .catch(() => undefined)
  return result
}

function operationResult(
  catalog: HostsCatalog,
  source: 'bundled' | 'downloaded',
  outcome: ApplyOutcome,
  message: string
): HostsOperationResult {
  return {
    ...overviewFrom(catalog, source, outcome.state, outcome.content, {
      recovery: outcome.recovery
    }),
    message,
    warnings: [...outcome.warnings, ...outcome.managed.warnings]
  }
}

function normalizeServiceSelection(
  catalog: HostsCatalog,
  service: HostsService,
  value: unknown
): HostsSelection {
  const wanted = typeof value === 'string' ? value : 'off'
  if (wanted === 'off') return 'off'
  if (service.kind === 'hosts') return wanted === 'hosts' ? 'hosts' : 'off'
  if (wanted === 'hosts') {
    return catalog.dnsProfiles[0]?.id ?? 'off'
  }
  return catalog.dnsProfiles.some((profile) => profile.id === wanted) ? wanted : 'off'
}

export async function setHostsServiceSelection(
  serviceId: string,
  value: unknown
): Promise<HostsOperationResult> {
  const { result, changed } = await withStateLock(async () => {
    const { catalog, source } = getHostsCatalog()
    const content = readHostsRawStrict()
    const { state, recovery } = await loadEffectiveState(catalog, content)
    const service = catalog.services.find((item) => item.id === serviceId)
    if (!service) throw new Error(`Сервис ${serviceId} не найден в каталоге`)

    const normalized = normalizeServiceSelection(catalog, service, value)
    if (
      service.kind === 'dns' &&
      normalized !== 'off' &&
      !serviceHasAnswers(service, normalized)
    ) {
      throw new Error(
        `Для ${service.name} нет адресов в профиле ${getDnsProfileName(catalog, normalized)}. ` +
          'Выберите другой DNS-профиль.'
      )
    }
    const restoreSelection = { ...(state.restoreSelection ?? {}) }
    delete restoreSelection[serviceId]
    const candidate: HostsState = {
      ...state,
      selection: { ...state.selection, [serviceId]: normalized },
      restoreSelection
    }
    // A toggle must answer immediately: cached verdicts only, no probes. A
    // cold cache means "apply as is"; «Проверить адреса» filters later.
    const outcome = await applyCandidate(catalog, candidate, { probe: 'cache', recovery })
    const profileName =
      normalized === 'hosts'
        ? 'Напрямую'
        : normalized === 'off'
          ? 'выключен'
          : getDnsProfileName(catalog, normalized)
    return {
      result: operationResult(
        catalog,
        source,
        outcome,
        `${service.name}: ${normalized === 'off' ? 'выключен' : `включён (${profileName})`}`
      ),
      changed: outcome.changed
    }
  })
  return scheduleDnsFlush(result, changed)
}

export async function setHostsDnsForAll(profileId: string): Promise<HostsOperationResult> {
  const { result, changed } = await withStateLock(async () => {
    const { catalog, source } = getHostsCatalog()
    const profile = catalog.dnsProfiles.find((item) => item.id === profileId)
    if (!profile) throw new Error(`DNS-профиль ${profileId} не найден`)

    const content = readHostsRawStrict()
    const { state, recovery } = await loadEffectiveState(catalog, content)
    const selection: Record<string, HostsSelection> = { ...state.selection }
    const kept: string[] = []
    for (const service of catalog.services) {
      if (service.kind !== 'dns') continue
      const current = selection[service.id]
      if (!current || current === 'off') continue
      if (serviceHasAnswers(service, profile.id)) {
        selection[service.id] = profile.id
      } else {
        kept.push(service.name)
      }
    }
    const candidate: HostsState = {
      ...state,
      defaultDnsProfile: profile.id,
      selection
    }
    const outcome = await applyCandidate(catalog, candidate, { probe: 'cache', recovery })
    const keptNote =
      kept.length > 0
        ? ` Без адресов в этом профиле: ${kept.slice(0, 3).join(', ')}${
            kept.length > 3 ? ` и ещё ${kept.length - 3}` : ''
          } — оставлены прежние профили.`
        : ''
    return {
      result: operationResult(
        catalog,
        source,
        outcome,
        `Профиль для включённых DNS-сервисов: ${profile.name}.${keptNote}`
      ),
      changed: outcome.changed
    }
  })
  return scheduleDnsFlush(result, changed)
}

export async function disableAllHostsServices(): Promise<HostsOperationResult> {
  const { result, changed } = await withStateLock(async () => {
    const { catalog, source } = getHostsCatalog()
    const content = readHostsRawStrict()
    const { state, recovery } = await loadEffectiveState(catalog, content)
    const selection: Record<string, HostsSelection> = {}
    for (const service of catalog.services) selection[service.id] = 'off'
    const candidate: HostsState = { ...state, selection, restoreSelection: {} }
    const outcome = await applyCandidate(catalog, candidate, { probe: 'cache', recovery })
    return {
      result: operationResult(catalog, source, outcome, 'Все сервисы выключены'),
      changed: outcome.changed
    }
  })
  return scheduleDnsFlush(result, changed)
}

export async function setHostsAdobeBlock(enabled: boolean): Promise<HostsOperationResult> {
  const { result, changed } = await withStateLock(async () => {
    const { catalog, source } = getHostsCatalog()
    const content = readHostsRawStrict()
    const { state, recovery } = await loadEffectiveState(catalog, content)
    const candidate: HostsState = { ...state, adobeBlock: enabled }
    const outcome = await applyCandidate(catalog, candidate, { probe: 'cache', recovery })
    return {
      result: operationResult(
        catalog,
        source,
        outcome,
        enabled ? 'Блокировка активации Adobe включена' : 'Блокировка активации Adobe выключена'
      ),
      changed: outcome.changed
    }
  })
  return scheduleDnsFlush(result, changed)
}

export async function importLegacyHostsBlocks(): Promise<HostsOperationResult> {
  const { result, changed } = await withStateLock(async () => {
    const { catalog, source } = getHostsCatalog()
    const content = readHostsRawStrict()
    const { state, recovery } = await loadEffectiveState(catalog, content)
    assertBalancedBlocks(content)
    const adobe = adobeData()
    const legacy = detectLegacyBlocks(content, adobe.set)
    const pairs = [...parseLegacyZapretGui(content), ...parseLegacySkipNet(content)]
    const adobePairs = parseAdobeEntries(content, adobe.set)

    if (!legacy.zapretGui && !legacy.skipNet && pairs.length === 0 && adobePairs.length === 0) {
      return {
        result: operationResult(
          catalog,
          source,
          {
            state,
            content,
            managed: renderManagedBlock(catalog, state),
            changed: false,
            warnings: []
          },
          'Блок ZapretGUI не найден'
        ),
        changed: false
      }
    }

    const unknown = countLegacyUnknownHostnames(catalog, pairs)
    if (unknown > 0) {
      throw new Error(
        `В блоке ZapretGUI есть ${unknown} записей, которых нет в каталоге. ` +
          'Блок оставлен без изменений, чтобы не потерять их.'
      )
    }
    const imported = importLegacySelection(catalog, pairs, state.defaultDnsProfile)
    if (pairs.length > 0 && Object.keys(imported).length === 0) {
      throw new Error(
        'Не удалось сопоставить записи ZapretGUI с каталогом. Блок оставлен без изменений.'
      )
    }

    const candidate: HostsState = {
      ...state,
      selection: { ...state.selection, ...imported },
      adobeBlock: state.adobeBlock || adobePairs.length > 0
    }
    const outcome = await applyCandidate(catalog, candidate, {
      allowLegacy: true,
      probe: 'cache',
      recovery
    })
    return {
      result: operationResult(
        catalog,
        source,
        outcome,
        `Импортировано сервисов: ${Object.keys(imported).length}` +
          (adobePairs.length > 0 ? ', блок Adobe сохранён' : '')
      ),
      changed: outcome.changed
    }
  })
  return scheduleDnsFlush(result, changed)
}

export async function reapplyHostsState(forceProbe = false): Promise<HostsOperationResult> {
  const { result, changed } = await withStateLock(async () => {
    const { catalog, source } = getHostsCatalog()
    const content = readHostsRawStrict()
    const { state, recovery } = await loadEffectiveState(catalog, content)
    // «Проверить адреса» is the one apply path that really probes; a plain
    // «Применить» reuses cached verdicts instead of blocking on the network.
    const outcome = await applyCandidate(catalog, state, {
      probe: forceProbe ? 'fresh' : 'cache',
      recovery
    })
    return {
      result: operationResult(catalog, source, outcome, 'Настройки hosts применены'),
      changed: outcome.changed
    }
  })
  return scheduleDnsFlush(result, changed)
}

/**
 * Services that are on, plus services the probe turned off earlier: those are
 * exactly the ones worth another chance once fresh addresses exist.
 *
 * Returned as `service id → hostnames`; the flattened unique list is what the
 * resolver consumes.
 */
function refreshTargets(catalog: HostsCatalog, state: HostsState): Map<string, string[]> {
  const targets = new Map<string, string[]>()
  for (const service of catalog.services) {
    const selection = serviceSelection(service, state)
    if (!selection) continue
    targets.set(service.id, selectedEntries(service, selection).map((entry) => entry.hostname))
  }
  for (const [serviceId, selection] of Object.entries(state.restoreSelection ?? {})) {
    if (!selection || selection === 'off') continue
    const service = catalog.services.find((item) => item.id === serviceId)
    if (!service) continue
    targets.set(serviceId, selectedEntries(service, selection).map((entry) => entry.hostname))
  }
  return targets
}

/**
 * Identity of one selection snapshot: catalog version plus a hash of the
 * enabled services and the restore hints. A refresh compares the snapshot it
 * probed against the selection it is about to write; a mismatch means the user
 * changed something while the probe was running and their change must win.
 */
export function hostsStateSignature(state: HostsState): string {
  const sortKeys = (input?: Record<string, HostsSelection>): Array<[string, string]> =>
    Object.entries(input ?? {})
      .map(([id, value]): [string, string] => [id, String(value)])
      .sort((a, b) => a[0].localeCompare(b[0]))
  const digest = createHash('sha256')
    .update(
      JSON.stringify([
        state.catalogVersion,
        sortKeys(state.selection),
        sortKeys(state.restoreSelection)
      ])
    )
    .digest('hex')
  return digest.slice(0, 16)
}

export interface RefreshMergeInput {
  catalog: HostsCatalog
  /** Selection as it is *now*, re-read after the probe finished. */
  current: HostsState
  /** Signature of the snapshot the probe was started from. */
  snapshotSignature: string
  /** Verified addresses from this refresh only. */
  resolved: Record<string, string[]>
  /** Injected clock for tests. */
  now?: string
}

export interface RefreshMergeResult {
  state: HostsState
  revived: string[]
  /** True when the user changed the selection while the probe was running. */
  stale: boolean
}

/**
 * Merge verified addresses into the *current* state.
 *
 * Only hostnames that are still selected (or still worth reviving) are merged,
 * so a toggle made during a slow refresh is never overwritten. Addresses that
 * now verify are also removed from `skippedIps` — otherwise the managed block
 * would keep filtering out the freshly verified IP.
 */
export function mergeRefreshResult(input: RefreshMergeInput): RefreshMergeResult {
  const { catalog, current, snapshotSignature, resolved } = input
  const stale = hostsStateSignature(current) !== snapshotSignature
  const targets = refreshTargets(catalog, current)
  const relevant = new Set(
    [...targets.values()].flat().map((hostname) => hostname.toLowerCase())
  )

  const merged: Record<string, string[]> = { ...(current.resolvedIps ?? {}) }
  const refreshed = new Set<string>()
  for (const [hostname, ips] of Object.entries(resolved)) {
    const key = hostname.toLowerCase()
    if (!relevant.has(key)) continue
    if (!Array.isArray(ips) || ips.length === 0) continue
    merged[key] = ips
    for (const ip of ips) refreshed.add(ip.toLowerCase())
  }

  const selection = { ...current.selection }
  const restoreSelection = { ...(current.restoreSelection ?? {}) }
  const revived: string[] = []

  for (const [serviceId, previous] of Object.entries(restoreSelection)) {
    if (!previous || previous === 'off') {
      delete restoreSelection[serviceId]
      continue
    }
    const serviceHostnames = targets.get(serviceId) ?? []
    // Revive only when this very refresh produced an address for the service.
    const hasLive = serviceHostnames.some(
      (hostname) => (resolved[hostname.toLowerCase()]?.length ?? 0) > 0
    )
    if (!hasLive) continue
    selection[serviceId] = previous
    delete restoreSelection[serviceId]
    const service = catalog.services.find((item) => item.id === serviceId)
    if (service) revived.push(service.name)
  }

  const skippedIps = (current.skippedIps ?? []).filter((ip) => !refreshed.has(ip.toLowerCase()))

  return {
    state: {
      ...current,
      selection,
      restoreSelection,
      skippedIps,
      resolvedIps: merged,
      resolvedAt:
        refreshed.size > 0
          ? (input.now ?? new Date().toISOString())
          : current.resolvedAt
    },
    revived,
    stale
  }
}

export interface RefreshOptions {
  /** Test seam / future alternative resolver. */
  resolveHosts?: typeof resolveHosts
  deadlineMs?: number
}

/**
 * Ask live DNS sources for current answers, prove them with a TLS handshake
 * and keep the fastest verified addresses. Without this a catalog snapshot
 * slowly turns every pin into a dead address and each connection waits for the
 * TCP timeout before falling back.
 *
 * Ordering (this is the whole point of C1):
 *   1. snapshot state under `withStateLock`, release the lock;
 *   2. resolve + probe outside the lock, with a cancellation signal;
 *   3. re-acquire the lock, re-read state, verify the snapshot is current and
 *      merge only hostnames that are still selected.
 *
 * A newer refresh aborts the one in flight; the aborted call still merges the
 * addresses it verified and says so in the message.
 */
export async function refreshHostsAddressesWith(
  options: RefreshOptions = {}
): Promise<HostsOperationResult> {
  // 1) Snapshot under the lock. No network here.
  const snapshot = await withStateLock(async () => {
    const { catalog, source } = getHostsCatalog()
    const read = readHostsRawLenient()
    const { state, recovery } = await loadEffectiveState(
      catalog,
      read.ok ? read.content : undefined
    )
    const targets = refreshTargets(catalog, state)
    const hostnames = [...new Set([...targets.values()].flat())]
    if (hostnames.length === 0) {
      throw new Error('Нет включённых сервисов — сначала включите хотя бы один')
    }
    return {
      catalog,
      source,
      recovery,
      hostnames,
      signature: hostsStateSignature(state)
    }
  })

  // 2) Probes outside the lock. A new refresh cancels this one.
  refreshController?.abort()
  const controller = new AbortController()
  refreshController = controller
  let result: ResolveResult
  try {
    const resolve = options.resolveHosts ?? resolveHosts
    result = await resolve(snapshot.hostnames, {
      signal: controller.signal,
      deadlineMs: options.deadlineMs ?? REFRESH_DEADLINE_MS
    })
  } finally {
    if (refreshController === controller) refreshController = null
  }

  const cancelledNote = result.stats.cancelled ? 'проверка отменена (новый запрос)' : ''
  const statsParts = [
    `Проверено доменов: ${result.stats.checked}`,
    `живые адреса найдены для ${result.stats.resolved}`,
    `всего IP: ${result.stats.addresses}`
  ]

  // 3) Merge under the lock. Nothing was verified → do not rewrite hosts.
  if (result.stats.resolved === 0) {
    return withStateLock(async () => {
      const { catalog, source } = getHostsCatalog()
      const read = readHostsRawLenient()
      const { state, recovery } = await loadEffectiveState(
        catalog,
        read.ok ? read.content : undefined
      )
      return {
        ...overviewFrom(catalog, source, state, read.content, {
          recovery: snapshot.recovery ?? recovery
        }),
        message: result.stats.cancelled
          ? `Обновление адресов отменено — ${statsParts.join(' · ')}`
          : 'Не удалось получить ни одного проверенного адреса: DoH недоступен ' +
            'или ресурсы блокируются по SNI. Попробуйте включить Zapret и повторить.' +
            (result.stats.timedOut ? ' Проверка остановлена по таймауту.' : ''),
        warnings: []
      }
    })
  }

  const { result: opResult, changed } = await withStateLock(async () => {
    const { catalog, source } = getHostsCatalog()
    const content = readHostsRawStrict()
    const { state, recovery } = await loadEffectiveState(catalog, content)
    const merge = mergeRefreshResult({
      catalog,
      current: state,
      snapshotSignature: snapshot.signature,
      resolved: result.resolved
    })
    // Addresses were verified by TLS with the hostname as SNI — probing them
    // again over TCP would only add a second, weaker check.
    const outcome = await applyCandidate(catalog, merge.state, {
      probe: 'off',
      recovery: snapshot.recovery ?? recovery
    })

    const parts = [...statsParts]
    if (merge.revived.length > 0) parts.push(`включено обратно сервисов: ${merge.revived.length}`)
    if (merge.stale) parts.push('выбор сервисов изменился во время проверки — применены только актуальные')
    if (result.stats.timedOut) parts.push('проверка остановлена по таймауту')
    if (cancelledNote) parts.push(cancelledNote)

    return {
      result: operationResult(catalog, source, outcome, parts.join(' · ')),
      changed: outcome.changed
    }
  })
  return scheduleDnsFlush(opResult, changed)
}

export function refreshHostsAddresses(): Promise<HostsOperationResult> {
  return refreshHostsAddressesWith()
}

/** Stop an in-flight refresh (used by tests and app shutdown). */
export function cancelHostsRefresh(): void {
  refreshController?.abort()
  refreshController = null
}

// A refresh must not keep DoH sockets open while the app is shutting down.
app.on('before-quit', () => {
  cancelHostsRefresh()
})

export async function restoreLatestHostsBackup(): Promise<HostsOperationResult> {
  const { result } = await withStateLock(async () => {
    const { catalog, source } = getHostsCatalog()
    const backup = latestBackup()
    if (!backup) throw new Error('Бэкапов файла hosts ещё нет')
    validateHostsFileContent(backup.content)

    // Make the restore itself undoable: keep the file that is about to be
    // replaced as the newest backup.
    const current = readHostsRawStrict()
    const currentState = loadHostsState(catalog)
    createBackup(current, currentState)

    const written = writeHostsContent(backup.content)
    if (!written.ok) {
      const rollback = writeHostsContent(current)
      throw new Error(
        `Не удалось восстановить hosts: ${written.error ?? 'неизвестная ошибка'}.` +
          (rollback.ok ? ' Текущий файл сохранён.' : '')
      )
    }
    const verify = readHostsRawStrict()
    if (verify !== backup.content) {
      const rollback = writeHostsContent(current)
      throw new Error(
        'Файл hosts восстановлен не полностью.' +
          (rollback.ok ? ' Текущий файл сохранён.' : ' Автоматический откат не удался.')
      )
    }
    // Always rebuild the selection from the restored file. The sidecar state
    // is only a hint (default profile), because backups made by older builds
    // stored the *new* selection next to the *old* file.
    const sidecar = backup.state ? normalizeHostsState(backup.state, catalog) : null
    const base = defaultHostsState(catalog)
    if (sidecar) {
      base.defaultDnsProfile = sidecar.defaultDnsProfile
    }
    const pairs = [
      ...parseEditorBlock(backup.content),
      ...parseLegacySkipNet(backup.content),
      ...parseLegacyZapretGui(backup.content)
    ]
    const imported = importLegacySelection(catalog, pairs, base.defaultDnsProfile)
    const hasMappings = backup.content
      .split(/\r\n|\r|\n/)
      .some((line) =>
        /^\s*(?:\d{1,3}(?:\.\d{1,3}){3}|[0-9a-f:]+)\s+/i.test(
          line.split('#', 1)[0].trim()
        )
      )
    if (hasMappings && Object.keys(imported).length === 0) {
      throw new Error(
        'В бэкапе есть записи, но не удалось восстановить состояние. Файл не изменён.'
      )
    }
    const state: HostsState = {
      ...base,
      selection: { ...base.selection, ...imported },
      adobeBlock: detectLegacyBlocks(backup.content, adobeData().set).adobe,
      appliedAt: new Date().toISOString(),
      renderedHash: hashHostsContent(backup.content)
    }
    await saveHostsState(state)
    const outcome: ApplyOutcome = {
      state,
      content: backup.content,
      managed: renderManagedBlock(catalog, state),
      changed: true,
      warnings: []
    }
    return {
      result: operationResult(
        catalog,
        source,
        outcome,
        'Файл hosts восстановлен из последнего бэкапа'
      ),
      changed: true
    }
  })
  return scheduleDnsFlush(result, true)
}

export async function openHostsFile(): Promise<void> {
  const target = windowsHostsPath()
  const error = await shell.openPath(target)
  if (error) shell.showItemInFolder(target)
}

export function flushHostsDns(): Promise<DnsFlushResult> {
  return flushDns()
}

export async function refreshHostsCatalog(): Promise<HostsCatalogUpdateResult> {
  const result = await updateHostsCatalog()
  invalidateHostsCatalogCache()
  return result
}

