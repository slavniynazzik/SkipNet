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
  normalizeHostsState,
  saveHostsState
} from './hosts-state'
import {
  assertBalancedBlocks,
  buildHostsContent,
  countEditorBlockLines,
  countLegacyUnknownHostnames,
  detectLegacyBlocks,
  extractBlock,
  hashHostsContent,
  importLegacySelection,
  parseAdobeEntries,
  parseEditorBlock,
  parseLegacySkipNet,
  parseLegacyZapretGui,
  renderAdobeBlock,
  renderManagedBlock,
  validateHostsFileContent,
  ADOBE_BLOCK_END,
  ADOBE_BLOCK_START,
  EDITOR_BLOCK_END,
  EDITOR_BLOCK_START,
  type RenderedHostsBlock
} from './hosts-render'

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
  state: HostsState
): HostsOverview {
  return {
    catalog,
    catalogSource: source,
    state,
    status: buildStatus(readHostsRawStrict(), state, catalog)
  }
}

/**
 * Persisted state plus one safety correction: if the file already contains an
 * Adobe block, keep it enabled instead of deleting it on the first unrelated
 * toggle. A new install has no such block and stays off by default.
 */
function loadEffectiveState(catalog: HostsCatalog): HostsState {
  const state = loadHostsState(catalog)
  const content = readHostsRawStrict()
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
  return next
}

export function getHostsOverview(): Promise<HostsOverview> {
  return withHostsLock(async () => {
    const { catalog, source } = getHostsCatalog()
    const state = loadEffectiveState(catalog)
    return overview(catalog, source, state)
  })
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

  createBackup(original, previousState)
  const written = writeHostsContent(nextContent)
  if (!written.ok) {
    // A failed direct write can leave the system file truncated before the
    // elevated fallback runs. Always put the original bytes back.
    const rollback = writeHostsContent(original)
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
    throw new Error(
      'Файл hosts записан, но проверка не совпала. ' +
        (rollback.ok ? 'Исходный файл восстановлен.' : 'Автоматический откат не удался.')
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
    const outcome = await applyCandidate(catalog, candidate)
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
          flush: { ok: true, message: 'Нечего импортировать.' }
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
