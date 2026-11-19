/**
 * Hosts editor orchestration: catalog + state + the Windows hosts file.
 *
 * Every mutation runs through `withHostsLock`, writes a backup first, verifies
 * the file after writing and rolls back on mismatch. Only the system hosts
 * path is ever touched; IPC cannot pass an arbitrary destination.
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
import { randomUUID } from 'node:crypto'
import { shell } from 'electron'
import { dataDir, resourcesDir } from '../utils/dirs'
import {
  flushDns,
  hostsFileWritable,
  readHostsRawStrict,
  windowsHostsPath,
  writeHostsContent
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
import { resolveHosts } from './hosts-resolver'

const BACKUPS_DIR = 'hosts-backups'
const MAX_BACKUPS = 20

const HOSTNAME_RE =
  /^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)(?:\.(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?))*$/i

function serviceHasAnswers(service: HostsService, profileId: string): boolean {
  return (service.domains ?? []).some((domain) => (domain.answers[profileId]?.length ?? 0) > 0)
}

let queue: Promise<void> = Promise.resolve()

/** Serialise every read-modify-write cycle on the system hosts file. */
function withHostsLock<T>(fn: () => Promise<T>): Promise<T> {
  const next = queue.then(fn, fn)
  queue = next.then(() => void 0, () => void 0)
  return next
}

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

function overview(
  catalog: HostsCatalog,
  source: 'bundled' | 'downloaded',
  state: HostsState,
  recovery?: HostsStateRecovery
): HostsOverview {
  const status = buildStatus(readHostsRawStrict(), state, catalog)
  return {
    catalog,
    catalogSource: source,
    state,
    status: recovery ? { ...status, recovery } : status,
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
  catalog: HostsCatalog
): Promise<{ state: HostsState; recovery?: HostsStateRecovery }> {
  const content = readHostsRawStrict()
  const loaded = await loadHostsStateRecovering(catalog, { hostsContent: content })
  const state = loaded.state
  const legacy = detectLegacyBlocks(content, adobeData().set)
  let next = state

  // Only recover selections from the file when there is no applied state.
  // Once `renderedHash` exists the user's saved selection is authoritative;
  // the external-change banner handles a mismatch instead of re-enabling a
  // service the user explicitly turned off.
  const firstApply = !state.renderedHash
  if (firstApply) {
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
  return { state: next, recovery: loaded.recovery }
}

export function getHostsOverview(): Promise<HostsOverview> {
  return withHostsLock(async () => {
    const { catalog, source } = getHostsCatalog()
    const { state, recovery } = await loadEffectiveState(catalog)
    return overview(catalog, source, state, recovery)
  })
}

interface ApplyOutcome {
  state: HostsState
  managed: RenderedHostsBlock
  changed: boolean
  flush: { ok: boolean; message: string }
  warnings: string[]
  recovery?: HostsStateRecovery
}

/**
 * Probe the addresses the current selection would write and drop the dead
 * ones. A service whose every address is unreachable is switched off: keeping
 * it enabled would only produce TCP timeouts and a "hosts is broken" feeling.
 */
function serviceSelection(service: HostsService, state: HostsState): string | null {
  const value = state.selection[service.id]
  if (!value || value === 'off') return null
  if (service.kind === 'hosts') return value === 'hosts' ? 'hosts' : null
  return value === 'hosts' ? state.defaultDnsProfile || null : value
}

async function planReachableState(
  catalog: HostsCatalog,
  state: HostsState,
  force = false
): Promise<{ state: HostsState; warnings: string[] }> {
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
  const control = await probeIps(['1.1.1.1', '8.8.8.8'], { force })
  if (![...control.values()].some(Boolean)) {
    return {
      state,
      warnings: [
        'Не удалось проверить адреса: нет доступа в интернет. Настройки не изменены.'
      ]
    }
  }

  const reachable = await probeIps([...all], { force })
  const skipped = [...all].filter((ip) => reachable.get(ip) === false)
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
    forceProbe?: boolean
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
  const planned = await planReachableState(catalog, candidate, options.forceProbe === true)
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
      managed,
      changed: false,
      flush: { ok: true, message: 'Файл hosts не изменился.' },
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

  const flush = flushDns()
  return {
    state: finalState,
    managed,
    changed: true,
    flush,
    warnings: planned.warnings,
    recovery
  }
}

function operationResult(
  catalog: HostsCatalog,
  source: 'bundled' | 'downloaded',
  outcome: ApplyOutcome,
  message: string
): HostsOperationResult {
  return {
    ...overview(catalog, source, outcome.state, outcome.recovery),
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

export function setHostsServiceSelection(
  serviceId: string,
  value: unknown
): Promise<HostsOperationResult> {
  return withHostsLock(async () => {
    const { catalog, source } = getHostsCatalog()
    const { state, recovery } = await loadEffectiveState(catalog)
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
    const outcome = await applyCandidate(catalog, candidate, { recovery })
    const profileName =
      normalized === 'hosts'
        ? 'Напрямую'
        : normalized === 'off'
          ? 'выключен'
          : getDnsProfileName(catalog, normalized)
    return operationResult(
      catalog,
      source,
      outcome,
      `${service.name}: ${normalized === 'off' ? 'выключен' : `включён (${profileName})`}`
    )
  })
}

export function setHostsDnsForAll(profileId: string): Promise<HostsOperationResult> {
  return withHostsLock(async () => {
    const { catalog, source } = getHostsCatalog()
    const profile = catalog.dnsProfiles.find((item) => item.id === profileId)
    if (!profile) throw new Error(`DNS-профиль ${profileId} не найден`)

    const { state, recovery } = await loadEffectiveState(catalog)
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
    const outcome = await applyCandidate(catalog, candidate, { recovery })
    const keptNote =
      kept.length > 0
        ? ` Без адресов в этом профиле: ${kept.slice(0, 3).join(', ')}${
            kept.length > 3 ? ` и ещё ${kept.length - 3}` : ''
          } — оставлены прежние профили.`
        : ''
    return operationResult(
      catalog,
      source,
      outcome,
      `Профиль для включённых DNS-сервисов: ${profile.name}.${keptNote}`
    )
  })
}

export function disableAllHostsServices(): Promise<HostsOperationResult> {
  return withHostsLock(async () => {
    const { catalog, source } = getHostsCatalog()
    const { state, recovery } = await loadEffectiveState(catalog)
    const selection: Record<string, HostsSelection> = {}
    for (const service of catalog.services) selection[service.id] = 'off'
    const candidate: HostsState = { ...state, selection, restoreSelection: {} }
    const outcome = await applyCandidate(catalog, candidate, { recovery })
    return operationResult(catalog, source, outcome, 'Все сервисы выключены')
  })
}

export function setHostsAdobeBlock(enabled: boolean): Promise<HostsOperationResult> {
  return withHostsLock(async () => {
    const { catalog, source } = getHostsCatalog()
    const { state, recovery } = await loadEffectiveState(catalog)
    const candidate: HostsState = { ...state, adobeBlock: enabled }
    const outcome = await applyCandidate(catalog, candidate, { recovery })
    return operationResult(
      catalog,
      source,
      outcome,
      enabled ? 'Блокировка активации Adobe включена' : 'Блокировка активации Adobe выключена'
    )
  })
}

export function importLegacyHostsBlocks(): Promise<HostsOperationResult> {
  return withHostsLock(async () => {
    const { catalog, source } = getHostsCatalog()
    const { state, recovery } = await loadEffectiveState(catalog)
    const content = readHostsRawStrict()
    assertBalancedBlocks(content)
    const adobe = adobeData()
    const legacy = detectLegacyBlocks(content, adobe.set)
    const pairs = [...parseLegacyZapretGui(content), ...parseLegacySkipNet(content)]
    const adobePairs = parseAdobeEntries(content, adobe.set)

    if (!legacy.zapretGui && !legacy.skipNet && pairs.length === 0 && adobePairs.length === 0) {
      return operationResult(
        catalog,
        source,
        {
          state,
          managed: renderManagedBlock(catalog, state),
          changed: false,
          flush: { ok: true, message: 'Нечего импортировать.' },
          warnings: []
        },
        'Блок ZapretGUI не найден'
      )
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
    const outcome = await applyCandidate(catalog, candidate, { allowLegacy: true, recovery })
    return operationResult(
      catalog,
      source,
      outcome,
      `Импортировано сервисов: ${Object.keys(imported).length}` +
        (adobePairs.length > 0 ? ', блок Adobe сохранён' : '')
    )
  })
}

export function reapplyHostsState(forceProbe = false): Promise<HostsOperationResult> {
  return withHostsLock(async () => {
    const { catalog, source } = getHostsCatalog()
    const { state, recovery } = await loadEffectiveState(catalog)
    const outcome = await applyCandidate(catalog, state, { forceProbe, recovery })
    return operationResult(catalog, source, outcome, 'Настройки hosts применены')
  })
}

/**
 * Ask live DNS sources for current answers, prove them with a TLS handshake
 * and keep the fastest verified addresses. Without this a catalog snapshot
 * slowly turns every pin into a dead address and each connection waits for the
 * TCP timeout before falling back.
 */
export function refreshHostsAddresses(): Promise<HostsOperationResult> {
  return withHostsLock(async () => {
    const { catalog, source } = getHostsCatalog()
    const { state, recovery } = await loadEffectiveState(catalog)

    // Services that are on, plus services the probe turned off earlier: those
    // are exactly the ones worth another chance once fresh addresses exist.
    const targets = new Map<string, string[]>()
    const collect = (service: HostsService, selection: string): string[] => {
      const hostnames = selectedEntries(service, selection).map((entry) => entry.hostname)
      targets.set(service.id, hostnames)
      return hostnames
    }

    const hostnames: string[] = []
    for (const service of catalog.services) {
      const selection = serviceSelection(service, state)
      if (!selection) continue
      hostnames.push(...collect(service, selection))
    }
    for (const [serviceId, selection] of Object.entries(state.restoreSelection ?? {})) {
      const service = catalog.services.find((item) => item.id === serviceId)
      if (!service || !selection || selection === 'off') continue
      hostnames.push(...collect(service, selection))
    }

    if (hostnames.length === 0) {
      throw new Error('Нет включённых сервисов — сначала включите хотя бы один')
    }

    const result = await resolveHosts(hostnames)
    if (result.stats.resolved === 0) {
      const outcome = await applyCandidate(catalog, state, { recovery })
      return operationResult(
        catalog,
        source,
        outcome,
        'Не удалось получить ни одного проверенного адреса: DoH недоступен или ресурсы блокируются по SNI. ' +
          'Попробуйте включить Zapret и повторить.'
      )
    }

    const selection = { ...state.selection }
    const restoreSelection = { ...(state.restoreSelection ?? {}) }
    const revived: string[] = []

    for (const [serviceId, previous] of Object.entries(restoreSelection)) {
      const serviceHostnames = targets.get(serviceId) ?? []
      const hasLive = serviceHostnames.some(
        (hostname) => (result.resolved[hostname.toLowerCase()]?.length ?? 0) > 0
      )
      if (!hasLive) continue
      selection[serviceId] = previous
      delete restoreSelection[serviceId]
      const service = catalog.services.find((item) => item.id === serviceId)
      if (service) revived.push(service.name)
    }

    const next: HostsState = {
      ...state,
      selection,
      restoreSelection,
      resolvedIps: result.resolved,
      resolvedAt: new Date().toISOString()
    }
    const outcome = await applyCandidate(catalog, next, { recovery })

    const parts = [
      `Проверено доменов: ${result.stats.checked}`,
      `живые адреса найдены для ${result.stats.resolved}`,
      `всего IP: ${result.stats.addresses}`
    ]
    if (revived.length > 0) parts.push(`включено обратно сервисов: ${revived.length}`)
    if (result.stats.timedOut) parts.push('проверка остановлена по таймауту')

    return operationResult(catalog, source, outcome, parts.join(' · '))
  })
}

export function restoreLatestHostsBackup(): Promise<HostsOperationResult> {
  return withHostsLock(async () => {
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
    flushDns()
    return {
      ...overview(catalog, source, state),
      message: 'Файл hosts восстановлен из последнего бэкапа',
      warnings: []
    }
  })
}

export async function openHostsFile(): Promise<void> {
  const target = windowsHostsPath()
  const error = await shell.openPath(target)
  if (error) shell.showItemInFolder(target)
}

export function flushHostsDns(): { ok: boolean; message: string } {
  return flushDns()
}

export async function refreshHostsCatalog(): Promise<HostsCatalogUpdateResult> {
  const result = await updateHostsCatalog()
  invalidateHostsCatalogCache()
  return result
}
