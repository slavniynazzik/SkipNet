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
  statSync,
  unlinkSync,
  writeFileSync
} from 'node:fs'
import path from 'node:path'
import { shell } from 'electron'
import { dataDir, resourcesDir } from '../utils/dirs'
import { flushDns, hostsFileWritable, readHostsRaw, windowsHostsPath, writeHostsContent } from './hosts-file'
import {
  getHostsCatalog,
  getDnsProfileName,
  invalidateHostsCatalogCache,
  updateHostsCatalog
} from './hosts-catalog'
import { loadHostsState, normalizeHostsState, saveHostsState } from './hosts-state'
import {
  buildHostsContent,
  countEditorBlockLines,
  detectLegacyBlocks,
  hashHostsContent,
  importLegacySelection,
  parseAdobeEntries,
  parseLegacySkipNet,
  parseLegacyZapretGui,
  renderAdobeBlock,
  renderManagedBlock,
  type RenderedHostsBlock
} from './hosts-render'

const BACKUPS_DIR = 'hosts-backups'
const MAX_BACKUPS = 20

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
    const parsed = JSON.parse(readFileSync(file, 'utf8')) as unknown
    const hosts = Array.isArray(parsed)
      ? [...new Set(parsed.filter((v): v is string => typeof v === 'string' && v.trim().length > 0))]
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
    const stamp = nowStamp()
    writeFileSync(path.join(dir, `hosts-${stamp}.bak`), Buffer.from(content, 'latin1'))
    writeFileSync(
      path.join(dir, `state-${stamp}.json`),
      `${JSON.stringify(state, null, 2)}\n`,
      'utf8'
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
        state = JSON.parse(readFileSync(stateFile, 'utf8')) as HostsState
      }
    } catch {
      state = null
    }
    return { content, state }
  } catch {
    return null
  }
}

function buildStatus(content: string, state: HostsState): HostsFileStatus {
  const { hosts } = adobeData()
  const adobeSet = new Set(hosts)
  const legacy = detectLegacyBlocks(content, adobeSet)
  const enabled = Object.values(state.selection).filter((value) => value !== 'off').length
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
    legacy
  }
}

function overview(
  catalog: HostsCatalog,
  source: 'bundled' | 'downloaded',
  state: HostsState
): HostsOverview {
  return {
    catalog,
    catalogSource: source,
    state,
    status: buildStatus(readHostsRaw(), state)
  }
}

/**
 * Persisted state plus one safety correction: if the file already contains an
 * Adobe block, keep it enabled instead of deleting it on the first unrelated
 * toggle. A new install has no such block and stays off by default.
 */
function loadEffectiveState(catalog: HostsCatalog): HostsState {
  const state = loadHostsState(catalog)
  const content = readHostsRaw()
  const legacy = detectLegacyBlocks(content, adobeData().set)
  let next = state

  // Migrate the old SkipNet Telegram/GitHub block into ordinary services the
  // first time it is seen. This keeps its entries alive after the block is
  // replaced by the editor's own block.
  if (legacy.skipNet) {
    const imported = importLegacySelection(
      catalog,
      parseLegacySkipNet(content),
      state.defaultDnsProfile
    )
    next = { ...next, selection: { ...next.selection, ...imported } }
  }
  if (legacy.adobe && !next.adobeBlock) next = { ...next, adobeBlock: true }
  return next
}

export function getHostsOverview(): HostsOverview {
  const { catalog, source } = getHostsCatalog()
  const state = loadEffectiveState(catalog)
  return overview(catalog, source, state)
}

interface ApplyOutcome {
  state: HostsState
  managed: RenderedHostsBlock
  changed: boolean
  flush: { ok: boolean; message: string }
}

async function applyCandidate(
  catalog: HostsCatalog,
  candidate: HostsState,
  options: { allowLegacy?: boolean } = {}
): Promise<ApplyOutcome> {
  const original = readHostsRaw()
  const adobe = adobeData()
  // Never silently replace an existing ZapretGUI block: the user must import
  // its services first, otherwise all its entries would disappear.
  if (!options.allowLegacy && detectLegacyBlocks(original, adobe.set).zapretGui) {
    throw new Error(
      'В файле hosts найден блок ZapretGUI. Сначала импортируйте его на этой странице.'
    )
  }
  const managed = renderManagedBlock(catalog, candidate)
  const adobeBlock = renderAdobeBlock(adobe.hosts)
  const nextContent = buildHostsContent(
    original,
    managed,
    adobeBlock,
    candidate.adobeBlock,
    adobe.set
  )
  const nextHash = hashHostsContent(nextContent)
  const changed = nextHash !== hashHostsContent(original)

  const finalState: HostsState = {
    ...candidate,
    catalogVersion: catalog.meta.version,
    selection: { ...candidate.selection },
    appliedAt: new Date().toISOString(),
    renderedHash: nextHash
  }

  if (!changed) {
    await saveHostsState(finalState)
    return {
      state: finalState,
      managed,
      changed: false,
      flush: { ok: true, message: 'Файл hosts не изменился.' }
    }
  }

  createBackup(original, candidate)
  const written = writeHostsContent(nextContent)
  if (!written.ok) {
    throw new Error(
      `Не удалось записать файл hosts: ${written.error ?? 'неизвестная ошибка'}. ` +
        'Запустите SkipNet от администратора.'
    )
  }

  const verify = readHostsRaw()
  if (hashHostsContent(verify) !== nextHash) {
    const rollback = writeHostsContent(original)
    throw new Error(
      'Файл hosts записан, но проверка не совпала. ' +
        (rollback.ok ? 'Изменения отменены из бэкапа.' : 'Автоматический откат не удался.')
    )
  }

  await saveHostsState(finalState)
  const flush = flushDns()
  return { state: finalState, managed, changed: true, flush }
}

function operationResult(
  catalog: HostsCatalog,
  source: 'bundled' | 'downloaded',
  outcome: ApplyOutcome,
  message: string
): HostsOperationResult {
  return {
    ...overview(catalog, source, outcome.state),
    message,
    warnings: outcome.managed.warnings
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
    const state = loadEffectiveState(catalog)
    const service = catalog.services.find((item) => item.id === serviceId)
    if (!service) throw new Error(`Сервис ${serviceId} не найден в каталоге`)

    const normalized = normalizeServiceSelection(catalog, service, value)
    const candidate: HostsState = {
      ...state,
      selection: { ...state.selection, [serviceId]: normalized }
    }
    const outcome = await applyCandidate(catalog, candidate)
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

    const state = loadEffectiveState(catalog)
    const selection: Record<string, HostsSelection> = { ...state.selection }
    for (const service of catalog.services) {
      if (service.kind === 'dns' && selection[service.id] && selection[service.id] !== 'off') {
        selection[service.id] = profile.id
      }
    }
    const candidate: HostsState = {
      ...state,
      defaultDnsProfile: profile.id,
      selection
    }
    const outcome = await applyCandidate(catalog, candidate)
    return operationResult(
      catalog,
      source,
      outcome,
      `Профиль для включённых DNS-сервисов: ${profile.name}`
    )
  })
}

export function disableAllHostsServices(): Promise<HostsOperationResult> {
  return withHostsLock(async () => {
    const { catalog, source } = getHostsCatalog()
    const state = loadEffectiveState(catalog)
    const selection: Record<string, HostsSelection> = {}
    for (const service of catalog.services) selection[service.id] = 'off'
    const candidate: HostsState = { ...state, selection }
    const outcome = await applyCandidate(catalog, candidate)
    return operationResult(catalog, source, outcome, 'Все сервисы выключены')
  })
}

export function setHostsAdobeBlock(enabled: boolean): Promise<HostsOperationResult> {
  return withHostsLock(async () => {
    const { catalog, source } = getHostsCatalog()
    const state = loadEffectiveState(catalog)
    const candidate: HostsState = { ...state, adobeBlock: enabled }
    const outcome = await applyCandidate(catalog, candidate)
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
    const state = loadEffectiveState(catalog)
    const content = readHostsRaw()
    const adobe = adobeData()
    const legacy = detectLegacyBlocks(content, adobe.set)
    const pairs = parseLegacyZapretGui(content)
    const adobePairs = parseAdobeEntries(content, adobe.set)

    if (!legacy.zapretGui && !legacy.skipNet && pairs.length === 0 && adobePairs.length === 0) {
      return operationResult(
        catalog,
        source,
        {
          state,
          managed: renderManagedBlock(catalog, state),
          changed: false,
          flush: { ok: true, message: 'Нечего импортировать.' }
        },
        'Блок ZapretGUI не найден'
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
    const outcome = await applyCandidate(catalog, candidate, { allowLegacy: true })
    return operationResult(
      catalog,
      source,
      outcome,
      `Импортировано сервисов: ${Object.keys(imported).length}` +
        (adobePairs.length > 0 ? ', блок Adobe сохранён' : '')
    )
  })
}

export function reapplyHostsState(): Promise<HostsOperationResult> {
  return withHostsLock(async () => {
    const { catalog, source } = getHostsCatalog()
    const state = loadEffectiveState(catalog)
    const outcome = await applyCandidate(catalog, state)
    return operationResult(catalog, source, outcome, 'Настройки hosts применены')
  })
}

export function restoreLatestHostsBackup(): Promise<HostsOperationResult> {
  return withHostsLock(async () => {
    const { catalog, source } = getHostsCatalog()
    const backup = latestBackup()
    if (!backup) throw new Error('Бэкапов файла hosts ещё нет')

    const written = writeHostsContent(backup.content)
    if (!written.ok) {
      throw new Error(
        `Не удалось восстановить hosts: ${written.error ?? 'неизвестная ошибка'}`
      )
    }
    const state = backup.state
      ? normalizeHostsState(backup.state, catalog)
      : loadHostsState(catalog)
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

/** Used by tests/diagnostics: the number of lines currently owned by SkipNet. */
export function hostsManagedLineCount(): number {
  return countEditorBlockLines(readHostsRaw())
}

/** Used by diagnostics to expose the actual file size. */
export function hostsFileSize(): number {
  try {
    return statSync(windowsHostsPath()).size
  } catch {
    return 0
  }
}
