/**
 * Hosts service catalog.
 *
 * The shipped catalog is generated from ZapretGUI's `hosts_catalog.sqlite3` by
 * `scripts/import-hosts-catalog.py` and stored in `resources/hosts-catalog.json`.
 * It contains services, their domains and the pre-computed IP answers for each
 * DNS profile. A newer catalog can be downloaded from the SkipNet repository
 * into userData; the bundled copy stays as a fallback.
 */

import { existsSync, readFileSync, statSync } from 'node:fs'
import { mkdir, rename, writeFile, unlink } from 'node:fs/promises'
import { randomUUID } from 'node:crypto'
import { isIP } from 'node:net'
import path from 'node:path'
import { dataDir, resourcesDir } from '../utils/dirs'
import { fetchGithub } from '../utils/github'

const CATALOG_FILE = 'hosts-catalog.json'
const DOWNLOADED_FILE = 'hosts-catalog.json'
const MAX_CATALOG_BYTES = 5 * 1024 * 1024

const DEFAULT_REMOTE_URL =
  'https://raw.githubusercontent.com/slavniynazzik/SkipNet/main/resources/hosts-catalog.json'

const HOSTNAME_RE =
  /^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)(?:\.(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?))*$/i

// Service/profile ids are written into hosts comments and state keys. Keep
// them free of whitespace/newlines so a malicious remote catalog cannot inject
// extra lines into the managed block.
const SAFE_ID_RE = /^[a-z0-9][a-z0-9._-]{0,127}$/i

export interface LoadedHostsCatalog {
  catalog: HostsCatalog
  source: 'bundled' | 'downloaded'
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value)
}

function asString(value: unknown, field: string): string {
  if (typeof value !== 'string' || !value.trim()) {
    throw new Error(`каталог: поле ${field} должно быть непустой строкой`)
  }
  // eslint-disable-next-line no-control-regex -- intentionally reject control chars
  if (/[\u0000-\u001f\u007f]/.test(value)) {
    throw new Error(`каталог: поле ${field} содержит управляющие символы`)
  }
  return value
}

function asNumber(value: unknown, field: string): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw new Error(`каталог: поле ${field} должно быть числом`)
  }
  return value
}

function validateHostname(value: unknown, field: string): string {
  const hostname = asString(value, field).trim().toLowerCase()
  if (!HOSTNAME_RE.test(hostname)) {
    throw new Error(`каталог: некорректный домен «${hostname}»`)
  }
  return hostname
}

function validateIp(value: unknown, field: string): string {
  const ip = asString(value, field).trim()
  if (!isIP(ip)) throw new Error(`каталог: некорректный IP «${ip}»`)
  return ip
}

function validateIps(value: unknown, field: string): string[] {
  if (!Array.isArray(value) || value.length === 0) {
    throw new Error(`каталог: ${field} должен быть непустым массивом IP`)
  }
  if (value.length > 32) {
    throw new Error(`каталог: ${field} содержит слишком много IP`)
  }
  return [...new Set(value.map((ip) => validateIp(ip, field)))]
}

/**
 * Validate and normalise the catalog. The bundled file is trusted, but a
 * downloaded update is not, so every field that reaches the hosts file goes
 * through the same checks.
 */
export function validateHostsCatalog(input: unknown): HostsCatalog {
  if (!isRecord(input)) throw new Error('каталог: ожидался объект')
  const metaRaw = input.meta
  if (!isRecord(metaRaw)) throw new Error('каталог: отсутствует meta')
  const meta: HostsCatalogMeta = {
    version: asString(metaRaw.version, 'meta.version'),
    sha256: typeof metaRaw.sha256 === 'string' ? metaRaw.sha256 : '',
    createdAt: typeof metaRaw.createdAt === 'string' ? metaRaw.createdAt : '',
    checkedAt: typeof metaRaw.checkedAt === 'string' ? metaRaw.checkedAt : undefined,
    schemaVersion: asNumber(metaRaw.schemaVersion ?? 1, 'meta.schemaVersion'),
    source: typeof metaRaw.source === 'string' ? metaRaw.source : ''
  }
  if (meta.schemaVersion !== 1) {
    throw new Error(`каталог: неподдерживаемая версия схемы ${meta.schemaVersion}`)
  }

  if (!Array.isArray(input.dnsProfiles) || input.dnsProfiles.length === 0) {
    throw new Error('каталог: отсутствует список DNS-профилей')
  }
  if (input.dnsProfiles.length > 32) {
    throw new Error('каталог: слишком много DNS-профилей')
  }
  const profileIds = new Set<string>()
  const dnsProfiles: HostsDnsProfile[] = input.dnsProfiles.map((raw, index) => {
    if (!isRecord(raw)) throw new Error(`каталог: dnsProfiles[${index}] должен быть объектом`)
    const id = asString(raw.id, `dnsProfiles[${index}].id`)
    if (!SAFE_ID_RE.test(id)) throw new Error(`каталог: недопустимый id профиля ${id}`)
    if (profileIds.has(id)) throw new Error(`каталог: дубликат DNS-профиля ${id}`)
    profileIds.add(id)
    return {
      id,
      name: asString(raw.name, `dnsProfiles[${index}].name`),
      order: asNumber(raw.order ?? index, `dnsProfiles[${index}].order`)
    }
  })
  dnsProfiles.sort((a, b) => a.order - b.order || a.name.localeCompare(b.name, 'ru'))

  if (!Array.isArray(input.services)) throw new Error('каталог: отсутствует список сервисов')
  if (input.services.length > 500) throw new Error('каталог: слишком много сервисов')

  const serviceIds = new Set<string>()
  const services: HostsService[] = input.services.map((raw, index) => {
    if (!isRecord(raw)) throw new Error(`каталог: services[${index}] должен быть объектом`)
    const id = asString(raw.id, `services[${index}].id`)
    if (!SAFE_ID_RE.test(id)) throw new Error(`каталог: недопустимый id сервиса ${id}`)
    if (serviceIds.has(id)) throw new Error(`каталог: дубликат сервиса ${id}`)
    serviceIds.add(id)

    const category = raw.category
    if (category !== 'direct' && category !== 'ai' && category !== 'other') {
      throw new Error(`каталог: неизвестная категория у ${id}`)
    }
    const kind = raw.kind
    if (kind !== 'hosts' && kind !== 'dns') {
      throw new Error(`каталог: неизвестный тип у ${id}`)
    }

    const service: HostsService = {
      id,
      name: asString(raw.name, `services[${index}].name`),
      category,
      kind,
      order: asNumber(raw.order ?? index, `services[${index}].order`),
      icon: typeof raw.icon === 'string' ? raw.icon : 'fa5s.globe',
      color: typeof raw.color === 'string' ? raw.color : null
    }

    if (kind === 'hosts') {
      if (!Array.isArray(raw.entries)) throw new Error(`каталог: ${id} не содержит entries`)
      if (raw.entries.length > 2000) {
        throw new Error(`каталог: ${id} содержит слишком много записей`)
      }
      service.entries = raw.entries.map((entry, entryIndex) => {
        if (!isRecord(entry)) throw new Error(`каталог: ${id}.entries[${entryIndex}]`)
        return {
          hostname: validateHostname(entry.hostname, `${id}.entries[${entryIndex}].hostname`),
          ips: validateIps(entry.ips, `${id}.entries[${entryIndex}].ips`)
        }
      })
    } else {
      if (!Array.isArray(raw.domains)) throw new Error(`каталог: ${id} не содержит domains`)
      if (raw.domains.length > 2000) {
        throw new Error(`каталог: ${id} содержит слишком много доменов`)
      }
      service.domains = raw.domains.map((domain, domainIndex) => {
        if (!isRecord(domain)) throw new Error(`каталог: ${id}.domains[${domainIndex}]`)
        const answersRaw = domain.answers
        if (!isRecord(answersRaw)) {
          throw new Error(`каталог: ${id}.domains[${domainIndex}].answers`)
        }
        const answers: Record<string, string[]> = {}
        for (const [profileId, ips] of Object.entries(answersRaw)) {
          if (!profileIds.has(profileId)) {
            throw new Error(`каталог: ${id} ссылается на неизвестный профиль ${profileId}`)
          }
          answers[profileId] = validateIps(ips, `${id}.${domain.hostname}.${profileId}`)
        }
        return {
          hostname: validateHostname(domain.hostname, `${id}.domains[${domainIndex}].hostname`),
          answers
        }
      })
    }

    return service
  })
  services.sort((a, b) => a.order - b.order || a.name.localeCompare(b.name, 'ru'))

  const totalHostnames = services.reduce(
    (total, service) =>
      total + (service.entries?.length ?? 0) + (service.domains?.length ?? 0),
    0
  )
  if (totalHostnames > 30_000) {
    throw new Error('каталог: слишком много доменов и записей')
  }

  return { meta, dnsProfiles, services }
}

function readCatalogFile(file: string): HostsCatalog | null {
  try {
    if (!existsSync(file)) return null
    if (statSync(file).size > MAX_CATALOG_BYTES) {
      throw new Error('файл каталога слишком большой')
    }
    const text = readFileSync(file, 'utf8')
    // The size can change between stat() and read(); check the bytes we
    // actually parsed as well.
    if (text.length > MAX_CATALOG_BYTES) {
      throw new Error('файл каталога слишком большой')
    }
    const raw = JSON.parse(text.replace(/^\uFEFF/, '')) as unknown
    return validateHostsCatalog(raw)
  } catch (e) {
    console.warn(
      `[hosts-catalog] ${file}: ${e instanceof Error ? e.message : String(e)}`
    )
    return null
  }
}

function readResponseTextCapped(res: Response, maxBytes: number): Promise<string> {
  const declared = Number(res.headers.get('content-length') ?? '0')
  if (Number.isFinite(declared) && declared > maxBytes) {
    throw new Error('Каталог слишком большой')
  }
  if (!res.body) {
    return res.text().then((text) => {
      if (text.length > maxBytes) throw new Error('Каталог слишком большой')
      return text
    })
  }

  const reader = res.body.getReader()
  const decoder = new TextDecoder()
  let total = 0
  let text = ''
  return (async () => {
    try {
      for (;;) {
        const { done, value } = await reader.read()
        if (done) break
        total += value.byteLength
        if (total > maxBytes) {
          await reader.cancel().catch(() => void 0)
          throw new Error('Каталог слишком большой')
        }
        text += decoder.decode(value, { stream: true })
      }
      return text + decoder.decode()
    } finally {
      reader.releaseLock?.()
    }
  })()
}

/**
 * A downloaded catalog may only update addresses for hostnames that already
 * exist in the bundled catalog. It cannot introduce a new service or map a
 * brand-new domain: that would let a compromised mirror add arbitrary
 * privileged hosts entries. New services therefore arrive with an app update.
 */
function assertRemoteOnlyUpdatesKnownHostnames(
  remote: HostsCatalog,
  bundled: HostsCatalog
): void {
  const bundledById = new Map(bundled.services.map((service) => [service.id, service]))
  for (const service of remote.services) {
    const base = bundledById.get(service.id)
    if (!base) {
      throw new Error(
        `Каталог добавляет новый сервис ${service.id}. Обновите приложение, чтобы получить его.`
      )
    }
    if (service.kind !== base.kind) {
      throw new Error(`Каталог меняет тип сервиса ${service.id}; обновите приложение.`)
    }
    const known = new Set<string>()
    for (const entry of base.entries ?? []) known.add(entry.hostname)
    for (const domain of base.domains ?? []) known.add(domain.hostname)
    for (const entry of service.entries ?? []) {
      if (!known.has(entry.hostname)) {
        throw new Error(`Каталог добавляет новый домен ${entry.hostname}; обновите приложение.`)
      }
    }
    for (const domain of service.domains ?? []) {
      if (!known.has(domain.hostname)) {
        throw new Error(`Каталог добавляет новый домен ${domain.hostname}; обновите приложение.`)
      }
    }
  }
  for (const service of bundled.services) {
    if (!remote.services.some((item) => item.id === service.id)) {
      throw new Error(`Каталог удаляет сервис ${service.id}; обновите приложение.`)
    }
  }
}

export function bundledCatalogPath(): string {
  return path.join(resourcesDir(), CATALOG_FILE)
}

export function downloadedCatalogPath(): string {
  return path.join(dataDir(), DOWNLOADED_FILE)
}

function compareVersion(a: string, b: string): number {
  const norm = (value: string): (number | string)[] =>
    value
      .split(/[.+-]/)
      .map((part) => (/^\d+$/.test(part) ? Number.parseInt(part, 10) : part))
  const aa = norm(a)
  const bb = norm(b)
  const len = Math.max(aa.length, bb.length)
  for (let i = 0; i < len; i++) {
    const av = aa[i] ?? 0
    const bv = bb[i] ?? 0
    if (typeof av === 'number' && typeof bv === 'number') {
      if (av !== bv) return av > bv ? 1 : -1
    } else {
      const as = String(av)
      const bs = String(bv)
      if (as !== bs) return as > bs ? 1 : -1
    }
  }
  return 0
}

let cache: LoadedHostsCatalog | null = null

export function invalidateHostsCatalogCache(): void {
  cache = null
}

/** Load the freshest available catalog (downloaded if it is not older). */
export function getHostsCatalog(): LoadedHostsCatalog {
  if (cache) return cache

  const bundled = readCatalogFile(bundledCatalogPath())
  let downloaded = readCatalogFile(downloadedCatalogPath())

  if (!bundled && !downloaded) {
    throw new Error('Каталог hosts не найден. Переустановите приложение.')
  }

  // A downloaded catalog in userData is not trusted blindly: it may only
  // update addresses for services/hostnames that already exist in the bundled
  // catalog. This also rejects a locally dropped catalog that would add new
  // domains to the privileged hosts write.
  if (downloaded && bundled) {
    try {
      assertRemoteOnlyUpdatesKnownHostnames(downloaded, bundled)
    } catch (e) {
      console.warn(
        `[hosts-catalog] ignoring downloaded catalog: ${
          e instanceof Error ? e.message : String(e)
        }`
      )
      downloaded = null
    }
  }

  if (
    downloaded &&
    (!bundled || compareVersion(downloaded.meta.version, bundled.meta.version) >= 0)
  ) {
    cache = { catalog: downloaded, source: 'downloaded' }
    return cache
  }
  cache = { catalog: bundled!, source: 'bundled' }
  return cache
}

export function getDnsProfileName(catalog: HostsCatalog, id: string): string {
  return catalog.dnsProfiles.find((profile) => profile.id === id)?.name ?? id
}

/**
 * Download a newer catalog from the SkipNet repository. Only a strictly newer
 * version replaces the current one, so a stale mirror cannot downgrade the
 * data. The file is validated before it is written to userData.
 */
export async function updateHostsCatalog(): Promise<HostsCatalogUpdateResult> {
  const url = process.env.SKIPNET_HOSTS_CATALOG_URL?.trim() || DEFAULT_REMOTE_URL
  const res = await fetchGithub(url, {
    headers: {
      'User-Agent': 'SkipNet-HostsCatalog',
      Accept: 'application/json',
      'Cache-Control': 'no-cache'
    },
    timeoutMs: 30_000
  })
  if (!res.ok) throw new Error(`Не удалось скачать каталог: HTTP ${res.status}`)

  const text = (await readResponseTextCapped(res, MAX_CATALOG_BYTES)).replace(/^\uFEFF/, '')
  if (!text.trim()) throw new Error('Сервер вернул пустой каталог')

  let remote: HostsCatalog
  try {
    remote = validateHostsCatalog(JSON.parse(text) as unknown)
  } catch (e) {
    throw new Error(
      `Скачанный каталог повреждён: ${e instanceof Error ? e.message : String(e)}`
    )
  }

  const bundled = readCatalogFile(bundledCatalogPath())
  if (!bundled) {
    throw new Error('Встроенный каталог не найден; обновление каталога недоступно.')
  }
  assertRemoteOnlyUpdatesKnownHostnames(remote, bundled)

  const current = getHostsCatalog().catalog
  if (compareVersion(remote.meta.version, current.meta.version) <= 0) {
    return { version: current.meta.version, updated: false, source: getHostsCatalog().source }
  }

  const target = downloadedCatalogPath()
  // Random + O_EXCL avoids a pre-created .tmp name being a hardlink to a
  // privileged file (the app may run elevated).
  const tmp = `${target}.${randomUUID()}.tmp`
  try {
    await mkdir(path.dirname(target), { recursive: true })
    await writeFile(tmp, text, { encoding: 'utf8', flag: 'wx' })
    await rename(tmp, target)
  } catch (e) {
    try {
      await unlink(tmp)
    } catch {
      /* noop */
    }
    throw new Error(
      `Не удалось сохранить каталог: ${e instanceof Error ? e.message : String(e)}`
    )
  }

  invalidateHostsCatalogCache()
  return { version: remote.meta.version, updated: true, source: 'downloaded' }
}
