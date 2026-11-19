/**
 * Allow-list schema for `AppConfig` patches received over IPC and for config
 * files read back from disk.
 *
 * No third-party dependency is used on purpose: the validator must stay a
 * tiny, auditable pure function. It is applied *before* `deepMerge`, so an
 * invalid patch is rejected without touching the in-memory config or disk.
 *
 * Two entry points:
 *  - `validateAppConfigPatch` — strict; throws `ConfigValidationError` with
 *    the offending field path.
 *  - `sanitizeAppConfig` — lenient; used on load. Unknown keys and unsafe path
 *    overrides (`tgws.binaryPath`, `zapret.bundlePath`) are dropped silently,
 *    invalid values fall back to the defaults via the normal merge.
 */

type ConfigRecord = Record<string, unknown>

interface FieldIssue {
  path: string
  message: string
}

type FieldSpec =
  | { kind: 'boolean' }
  | {
      kind: 'string'
      maxLength?: number
      pattern?: RegExp
      patternMessage?: string
    }
  | { kind: 'integer'; min: number; max: number }
  | { kind: 'enum'; values: readonly string[] }
  | {
      kind: 'stringArray'
      maxItems: number
      maxItemLength: number
      itemPattern?: RegExp
      itemPatternMessage?: string
    }
  | { kind: 'object'; fields: Record<string, FieldSpec> }

const BLOCKED_KEYS = new Set(['__proto__', 'constructor', 'prototype'])

/** Path overrides from older builds that must never be honoured again. */
const DROPPED_KEYS = new Set(['binarypath', 'bundlepath'])

const HOSTNAME = /^(?:[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?)(?:\.(?:[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?))*$/
const SECRET_HEX = /^[0-9a-fA-F]{32}$/
const STRATEGY_FILE = /^general[^\\/]*\.bat$/i
const DC_IP = /^[0-9a-fA-F:.]+$/
const GAME_FILTER_RANGE = /^[0-9,\s-]*$/
const WORKSHOP_ID = /^[0-9]*$/

function isPlainObject(value: unknown): value is ConfigRecord {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false
  const proto = Object.getPrototypeOf(value)
  return proto === Object.prototype || proto === null
}

const WALLPAPER_FIELDS: Record<string, FieldSpec> = {
  enabled: { kind: 'boolean' },
  source: { kind: 'enum', values: ['image', 'video', 'workshop'] },
  path: { kind: 'string', maxLength: 4096 },
  workshopId: {
    kind: 'string',
    maxLength: 64,
    pattern: WORKSHOP_ID,
    patternMessage: 'ожидался числовой id предмета Workshop'
  },
  opacity: { kind: 'integer', min: 10, max: 100 },
  blur: { kind: 'integer', min: 0, max: 32 },
  dim: { kind: 'integer', min: 0, max: 90 }
}

const TGWS_FIELDS: Record<string, FieldSpec> = {
  enabled: { kind: 'boolean' },
  autoStart: { kind: 'boolean' },
  host: {
    kind: 'string',
    maxLength: 253,
    pattern: HOSTNAME,
    patternMessage: 'ожидался localhost или корректное имя хоста'
  },
  port: { kind: 'integer', min: 1024, max: 65535 },
  secret: {
    kind: 'string',
    maxLength: 32,
    pattern: SECRET_HEX,
    patternMessage: 'ожидалось ровно 32 hex-символа (0–9, a–f)'
  },
  dcIp: {
    kind: 'stringArray',
    maxItems: 32,
    maxItemLength: 64,
    itemPattern: DC_IP,
    itemPatternMessage: 'ожидался формат "2:149.154.167.220"'
  },
  bufKb: { kind: 'integer', min: 16, max: 65536 },
  poolSize: { kind: 'integer', min: 1, max: 64 },
  verbose: { kind: 'boolean' },
  cfproxy: { kind: 'boolean' },
  cfproxyPriority: { kind: 'boolean' },
  cfproxyUserDomain: { kind: 'string', maxLength: 253 },
  fakeTlsDomain: { kind: 'string', maxLength: 253 },
  installedVersion: { kind: 'string', maxLength: 128 },
  dismissedUpdateTag: { kind: 'string', maxLength: 128 }
}

const ZAPRET_FIELDS: Record<string, FieldSpec> = {
  enabled: { kind: 'boolean' },
  autoStart: { kind: 'boolean' },
  activeStrategy: {
    kind: 'string',
    maxLength: 128,
    pattern: STRATEGY_FILE,
    patternMessage: 'ожидалось имя файла general*.bat из бандла (без пути)'
  },
  gameFilter: { kind: 'boolean' },
  gameFilterMode: { kind: 'enum', values: ['disabled', 'all', 'tcp', 'udp'] },
  gameFilterTcpRange: {
    kind: 'string',
    maxLength: 64,
    pattern: GAME_FILTER_RANGE,
    patternMessage: 'ожидался диапазон портов, например 1024-65535'
  },
  gameFilterUdpRange: {
    kind: 'string',
    maxLength: 64,
    pattern: GAME_FILTER_RANGE,
    patternMessage: 'ожидался диапазон портов, например 1024-65535'
  },
  ipsetMode: { kind: 'enum', values: ['none', 'loaded', 'any'] },
  checkUpdates: { kind: 'boolean' },
  useService: { kind: 'boolean' },
  installedVersion: { kind: 'string', maxLength: 128 },
  dismissedUpdateTag: { kind: 'string', maxLength: 128 }
}

/** Every top-level key `AppConfig` actually has. Anything else is rejected. */
const APP_CONFIG_FIELDS: Record<string, FieldSpec> = {
  configVersion: { kind: 'integer', min: 0, max: 1_000_000 },
  lastBuildId: { kind: 'string', maxLength: 128 },
  appTheme: { kind: 'enum', values: ['light', 'dark'] },
  customTheme: { kind: 'string', maxLength: 128 },
  wallpaper: { kind: 'object', fields: WALLPAPER_FIELDS },
  disableTray: { kind: 'boolean' },
  hideTaskbarIcon: { kind: 'boolean' },
  autoLaunch: { kind: 'boolean' },
  silentStart: { kind: 'boolean' },
  launchTelegram: { kind: 'boolean' },
  launchDiscord: { kind: 'boolean' },
  language: { kind: 'enum', values: ['en-US', 'ru-RU', 'zh-CN'] },
  autoCheckUpdate: { kind: 'boolean' },
  dismissedAppUpdateTag: { kind: 'string', maxLength: 128 },
  maxLogDays: { kind: 'integer', min: 1, max: 365 },
  showWindowShortcut: { kind: 'string', maxLength: 128 },
  restartAppShortcut: { kind: 'string', maxLength: 128 },
  tgwsToggleShortcut: { kind: 'string', maxLength: 128 },
  zapretToggleShortcut: { kind: 'string', maxLength: 128 },
  disableGPU: { kind: 'boolean' },
  tgws: { kind: 'object', fields: TGWS_FIELDS },
  zapret: { kind: 'object', fields: ZAPRET_FIELDS }
}

export class ConfigValidationError extends Error {
  readonly field: string
  readonly issues: FieldIssue[]

  constructor(issues: FieldIssue[]) {
    super(
      `Некорректные настройки: ${issues
        .map((issue) => `${issue.path}: ${issue.message}`)
        .join('; ')}`
    )
    this.name = 'ConfigValidationError'
    this.issues = issues
    this.field = issues[0]?.path ?? ''
  }
}

function validateValue(
  value: unknown,
  spec: FieldSpec,
  path: string,
  issues: FieldIssue[]
): unknown {
  if (value === undefined) return undefined

  switch (spec.kind) {
    case 'boolean':
      if (typeof value !== 'boolean') {
        issues.push({ path, message: 'ожидалось true или false' })
        return undefined
      }
      return value

    case 'string': {
      if (typeof value !== 'string') {
        issues.push({ path, message: 'ожидалась строка' })
        return undefined
      }
      if (spec.maxLength !== undefined && value.length > spec.maxLength) {
        issues.push({ path, message: `длина не должна превышать ${spec.maxLength}` })
        return undefined
      }
      if (spec.pattern && !spec.pattern.test(value)) {
        issues.push({ path, message: spec.patternMessage ?? 'некорректный формат' })
        return undefined
      }
      return value
    }

    case 'integer':
      if (typeof value !== 'number' || !Number.isInteger(value)) {
        issues.push({ path, message: 'ожидалось целое число' })
        return undefined
      }
      if (value < spec.min || value > spec.max) {
        issues.push({ path, message: `допустимый диапазон ${spec.min}–${spec.max}` })
        return undefined
      }
      return value

    case 'enum':
      if (typeof value !== 'string' || !spec.values.includes(value)) {
        issues.push({ path, message: `допустимые значения: ${spec.values.join(', ')}` })
        return undefined
      }
      return value

    case 'stringArray': {
      if (!Array.isArray(value)) {
        issues.push({ path, message: 'ожидался массив строк' })
        return undefined
      }
      if (value.length > spec.maxItems) {
        issues.push({ path, message: `допустимо не более ${spec.maxItems} элементов` })
        return undefined
      }
      const items: string[] = []
      for (let i = 0; i < value.length; i++) {
        const item = value[i]
        const itemPath = `${path}[${i}]`
        if (typeof item !== 'string') {
          issues.push({ path: itemPath, message: 'ожидалась строка' })
          continue
        }
        if (item.length > spec.maxItemLength) {
          issues.push({ path: itemPath, message: `длина не должна превышать ${spec.maxItemLength}` })
          continue
        }
        if (spec.itemPattern && !spec.itemPattern.test(item)) {
          issues.push({
            path: itemPath,
            message: spec.itemPatternMessage ?? 'некорректный формат'
          })
          continue
        }
        items.push(item)
      }
      return items
    }

    case 'object': {
      if (!isPlainObject(value)) {
        issues.push({ path, message: 'ожидался объект' })
        return undefined
      }
      const clean: ConfigRecord = {}
      for (const key of Object.keys(value)) {
        const keyPath = `${path}.${key}`
        if (BLOCKED_KEYS.has(key)) {
          issues.push({ path: keyPath, message: 'недопустимый ключ' })
          continue
        }
        if (DROPPED_KEYS.has(key.toLowerCase())) {
          issues.push({ path: keyPath, message: 'переопределение пути компонента запрещено' })
          continue
        }
        const fieldSpec = spec.fields[key]
        if (!fieldSpec) {
          issues.push({ path: keyPath, message: 'неизвестный параметр' })
          continue
        }
        const result = validateValue(value[key], fieldSpec, keyPath, issues)
        if (result !== undefined || value[key] === undefined) clean[key] = result
      }
      return clean
    }
  }
}

/** Strictly validate an IPC/config patch. Throws `ConfigValidationError`. */
export function validateAppConfigPatch(patch: unknown): Partial<AppConfig> {
  if (!isPlainObject(patch)) {
    throw new ConfigValidationError([{ path: 'config', message: 'ожидался объект настроек' }])
  }
  const issues: FieldIssue[] = []
  const clean: ConfigRecord = {}

  for (const key of Object.keys(patch)) {
    if (BLOCKED_KEYS.has(key)) {
      issues.push({ path: key, message: 'недопустимый ключ' })
      continue
    }
    const fieldSpec = APP_CONFIG_FIELDS[key]
    if (!fieldSpec) {
      issues.push({ path: key, message: 'неизвестный параметр' })
      continue
    }
    const result = validateValue(patch[key], fieldSpec, key, issues)
    if (result !== undefined || patch[key] === undefined) clean[key] = result
  }

  if (issues.length) throw new ConfigValidationError(issues)
  return clean as Partial<AppConfig>
}

/**
 * Lenient sanitizer for configs read from disk. Drops unknown keys, prototype
 * pollution keys and the legacy `binaryPath` / `bundlePath` overrides instead
 * of failing the whole config (a stale file must never brick startup).
 */
function sanitizeValue(value: unknown, spec: FieldSpec): unknown {
  if (value === undefined) return undefined

  switch (spec.kind) {
    case 'boolean':
      return typeof value === 'boolean' ? value : undefined

    case 'string':
      if (typeof value !== 'string') return undefined
      if (spec.maxLength !== undefined && value.length > spec.maxLength) return undefined
      if (spec.pattern && !spec.pattern.test(value)) return undefined
      return value

    case 'integer':
      if (typeof value !== 'number' || !Number.isInteger(value)) return undefined
      if (value < spec.min || value > spec.max) return undefined
      return value

    case 'enum':
      return typeof value === 'string' && spec.values.includes(value) ? value : undefined

    case 'stringArray': {
      if (!Array.isArray(value) || value.length > spec.maxItems) return undefined
      const items = value.filter(
        (item): item is string =>
          typeof item === 'string' &&
          item.length <= spec.maxItemLength &&
          (!spec.itemPattern || spec.itemPattern.test(item))
      )
      return items
    }

    case 'object': {
      if (!isPlainObject(value)) return undefined
      const clean: ConfigRecord = {}
      for (const key of Object.keys(value)) {
        if (BLOCKED_KEYS.has(key) || DROPPED_KEYS.has(key.toLowerCase())) continue
        const fieldSpec = spec.fields[key]
        if (!fieldSpec) continue
        const result = sanitizeValue(value[key], fieldSpec)
        if (result !== undefined) clean[key] = result
      }
      return clean
    }
  }
}

/** Drop unsafe/unknown config keys before merging over the defaults. */
export function sanitizeAppConfig(raw: unknown): Partial<AppConfig> {
  if (!isPlainObject(raw)) return {}
  const clean: ConfigRecord = {}
  for (const key of Object.keys(raw)) {
    if (BLOCKED_KEYS.has(key)) continue
    const fieldSpec = APP_CONFIG_FIELDS[key]
    if (!fieldSpec) continue
    const result = sanitizeValue(raw[key], fieldSpec)
    if (result !== undefined) clean[key] = result
  }
  return clean as Partial<AppConfig>
}
