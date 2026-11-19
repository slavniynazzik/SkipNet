import { describe, expect, it } from 'vitest'
import {
  ConfigValidationError,
  sanitizeAppConfig,
  validateAppConfigPatch
} from '@main/config/schema'

const SECRET = '0123456789abcdef0123456789abcdef'

const FULL_PATCH: Partial<AppConfig> = {
  appTheme: 'dark',
  customTheme: 'custom.css',
  disableTray: false,
  hideTaskbarIcon: true,
  autoLaunch: true,
  silentStart: false,
  launchTelegram: true,
  launchDiscord: false,
  language: 'ru-RU',
  autoCheckUpdate: true,
  dismissedAppUpdateTag: 'v1.5.0',
  maxLogDays: 7,
  showWindowShortcut: 'Control+Shift+S',
  restartAppShortcut: 'Control+Shift+R',
  tgwsToggleShortcut: 'Control+Shift+T',
  zapretToggleShortcut: 'Control+Shift+Z',
  disableGPU: false,
  wallpaper: {
    enabled: true,
    source: 'image',
    path: 'C:\\Users\\me\\wall.png',
    workshopId: '123456789',
    opacity: 80,
    blur: 4,
    dim: 20
  },
  tgws: {
    enabled: true,
    autoStart: true,
    host: '127.0.0.1',
    port: 1443,
    secret: SECRET,
    dcIp: ['2:149.154.167.220', '4:149.154.167.220'],
    bufKb: 256,
    poolSize: 4,
    verbose: false,
    cfproxy: true,
    cfproxyPriority: true,
    cfproxyUserDomain: '',
    fakeTlsDomain: 'example.com',
    installedVersion: '1.11.4',
    dismissedUpdateTag: 'v1.11.4'
  },
  zapret: {
    enabled: true,
    autoStart: false,
    activeStrategy: 'general (ALT).bat',
    gameFilter: false,
    gameFilterMode: 'disabled',
    gameFilterTcpRange: '1024-65535',
    gameFilterUdpRange: '1024-65535,2048',
    ipsetMode: 'loaded',
    checkUpdates: true,
    useService: false,
    installedVersion: '1.10.4',
    dismissedUpdateTag: 'v1.10.4'
  }
}

function expectField(patch: unknown, field: string): void {
  try {
    validateAppConfigPatch(patch)
  } catch (e) {
    expect(e).toBeInstanceOf(ConfigValidationError)
    const error = e as ConfigValidationError
    expect(error.message).toContain(field)
    expect(error.field).toBe(field)
    return
  }
  throw new Error(`expected patch to be rejected at ${field}`)
}

describe('validateAppConfigPatch', () => {
  it('accepts a full patch covering every AppConfig section', () => {
    expect(() => validateAppConfigPatch(FULL_PATCH)).not.toThrow()
    expect(() => validateAppConfigPatch(structuredClone(FULL_PATCH))).not.toThrow()
  })

  it('accepts partial nested patches (renderer field edits)', () => {
    expect(() => validateAppConfigPatch({ tgws: { port: 2048 } })).not.toThrow()
    expect(() => validateAppConfigPatch({ tgws: { host: 'localhost' } })).not.toThrow()
    expect(() => validateAppConfigPatch({ tgws: { secret: SECRET } })).not.toThrow()
    expect(() => validateAppConfigPatch({ appTheme: 'light' })).not.toThrow()
    expect(() =>
      validateAppConfigPatch({ zapret: { activeStrategy: undefined } })
    ).not.toThrow()
  })

  it('returns only allow-listed keys', () => {
    const clean = validateAppConfigPatch({ appTheme: 'dark', autoLaunch: true })

    expect(clean).toEqual({ appTheme: 'dark', autoLaunch: true })
  })

  it('rejects unknown top-level keys', () => {
    expectField({ binaryPath: 'C:\\evil.exe' }, 'binaryPath')
    expectField({ someFutureKey: true }, 'someFutureKey')
  })

  it('rejects tgws.binaryPath from persisted/legacy payloads', () => {
    expectField({ tgws: { binaryPath: 'C:\\Users\\me\\TgWsProxy.exe' } }, 'tgws.binaryPath')
  })

  it('rejects unknown nested keys', () => {
    expectField({ tgws: { nope: true } }, 'tgws.nope')
    expectField({ zapret: { nope: true } }, 'zapret.nope')
    expectField({ wallpaper: { nope: true } }, 'wallpaper.nope')
  })

  it('rejects wrong scalar types (no coercion)', () => {
    expectField({ autoLaunch: 'true' }, 'autoLaunch')
    expectField({ autoCheckUpdate: 1 }, 'autoCheckUpdate')
    expectField({ maxLogDays: '7' }, 'maxLogDays')
    expectField({ disableGPU: [] }, 'disableGPU')
    expectField({ tgws: { enabled: null } }, 'tgws.enabled')
    expectField({ wallpaper: 'image' }, 'wallpaper')
  })

  it('rejects arrays where scalars are expected', () => {
    expectField({ silentStart: [true] }, 'silentStart')
    expectField({ appTheme: ['dark'] }, 'appTheme')
    expectField({ tgws: { port: [1443] } }, 'tgws.port')
  })

  it('enforces the tgws port range', () => {
    expectField({ tgws: { port: 80 } }, 'tgws.port')
    expectField({ tgws: { port: 70000 } }, 'tgws.port')
    expectField({ tgws: { port: 1443.5 } }, 'tgws.port')
    expectField({ tgws: { port: '1443' } }, 'tgws.port')
  })

  it('enforces bufKb / poolSize bounds', () => {
    expectField({ tgws: { bufKb: 0 } }, 'tgws.bufKb')
    expectField({ tgws: { bufKb: 1_000_000 } }, 'tgws.bufKb')
    expectField({ tgws: { poolSize: 0 } }, 'tgws.poolSize')
    expectField({ tgws: { poolSize: 1000 } }, 'tgws.poolSize')
  })

  it('requires a 32-hex secret', () => {
    expectField({ tgws: { secret: 'abc' } }, 'tgws.secret')
    expectField({ tgws: { secret: 'z'.repeat(32) } }, 'tgws.secret')
    expectField({ tgws: { secret: 'a'.repeat(31) } }, 'tgws.secret')
    expectField({ tgws: { secret: 'a'.repeat(33) } }, 'tgws.secret')
  })

  it('requires a loopback address or hostname', () => {
    expectField({ tgws: { host: 'http://127.0.0.1' } }, 'tgws.host')
    expectField({ tgws: { host: 'bad host' } }, 'tgws.host')
    expectField({ tgws: { host: 'a/b' } }, 'tgws.host')
  })

  it('validates dcIp entries', () => {
    expectField({ tgws: { dcIp: ['not-an-ip'] } }, 'tgws.dcIp[0]')
    expectField({ tgws: { dcIp: '2:149.154.167.220' } }, 'tgws.dcIp')
  })

  it('requires activeStrategy to be a bare general*.bat name', () => {
    expectField({ zapret: { activeStrategy: '..\\evil.bat' } }, 'zapret.activeStrategy')
    expectField({ zapret: { activeStrategy: 'sub/general.bat' } }, 'zapret.activeStrategy')
    expectField({ zapret: { activeStrategy: 'evil.bat' } }, 'zapret.activeStrategy')
    expectField({ zapret: { activeStrategy: 'general.exe' } }, 'zapret.activeStrategy')
  })

  it('validates theme, language and enums', () => {
    expectField({ appTheme: 'purple' }, 'appTheme')
    expectField({ language: 'fr-FR' }, 'language')
    expectField({ zapret: { ipsetMode: 'everything' } }, 'zapret.ipsetMode')
    expectField({ zapret: { gameFilterMode: 'both' } }, 'zapret.gameFilterMode')
    expectField({ wallpaper: { source: 'web' } }, 'wallpaper.source')
  })

  it('validates wallpaper ranges', () => {
    expectField({ wallpaper: { opacity: 5 } }, 'wallpaper.opacity')
    expectField({ wallpaper: { opacity: 101 } }, 'wallpaper.opacity')
    expectField({ wallpaper: { blur: 33 } }, 'wallpaper.blur')
    expectField({ wallpaper: { dim: 91 } }, 'wallpaper.dim')
  })

  it('rejects prototype-pollution payloads', () => {
    const payload = JSON.parse(`{"__proto__":{"polluted":"yes"}}`) as object

    expectField(payload, '__proto__')
    expect(({} as Record<string, unknown>).polluted).toBeUndefined()

    const nested = JSON.parse(`{"tgws":{"__proto__":{"polluted":"yes"}}}`) as object
    expectField(nested, 'tgws.__proto__')
  })

  it('rejects non-object patches', () => {
    expectField([], 'config')
    expectField('nope', 'config')
    expectField(null, 'config')
  })
})

describe('sanitizeAppConfig', () => {
  it('drops tgws.binaryPath silently', () => {
    const clean = sanitizeAppConfig({
      appTheme: 'dark',
      tgws: { port: 1443, binaryPath: 'C:\\Users\\me\\TgWsProxy.exe' }
    })

    expect(clean).toEqual({ appTheme: 'dark', tgws: { port: 1443 } })
  })

  it('drops unknown keys, invalid values and prototype keys', () => {
    const raw = JSON.parse(
      `{"appTheme":"purple","autoLaunch":"yes","unknownKey":1,"__proto__":{"polluted":true},"tgws":{"port":80,"host":"127.0.0.1"}}`
    ) as unknown

    const clean = sanitizeAppConfig(raw)

    expect(clean).toEqual({ tgws: { host: '127.0.0.1' } })
    expect(({} as Record<string, unknown>).polluted).toBeUndefined()
  })

  it('keeps legacy configs usable and non-object input safe', () => {
    expect(sanitizeAppConfig(null)).toEqual({})
    expect(sanitizeAppConfig([1, 2])).toEqual({})
    expect(sanitizeAppConfig({ appTheme: 'light', maxLogDays: 30 })).toEqual({
      appTheme: 'light',
      maxLogDays: 30
    })
  })
})
