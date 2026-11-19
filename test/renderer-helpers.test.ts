/**
 * Unit tests for the pure renderer helpers added by the P2 renderer fixes.
 *
 * These modules deliberately avoid React/SWR imports so they run in the node
 * vitest environment: the patch builders (R2), the update-check gating
 * predicates (R3) and the hosts DNS-profile fallback (R21).
 */
import { describe, expect, it } from 'vitest'
import {
  tgwsPatch,
  wallpaperPatch,
  zapretPatch
} from '../src/renderer/src/lib/config-patch'
import {
  UPDATE_DEDUPING_MS,
  revealAfterManualCheck,
  shouldAutoCheckUpdates,
  updateBannerVisible,
  updateDismissTag
} from '../src/renderer/src/lib/update-check'
import {
  defaultProfileFor,
  hasAnswers,
  profileOptionsFor
} from '../src/renderer/src/lib/hosts-profile'

function appConfig(patch: Partial<AppConfig> = {}): AppConfig {
  return {
    appTheme: 'dark',
    autoCheckUpdate: true,
    maxLogDays: 7,
    disableGPU: false,
    ...patch
  }
}

function dnsService(answers: Record<string, string[]>): HostsService {
  return {
    id: 'svc',
    name: 'Service',
    category: 'ai',
    kind: 'dns',
    order: 0,
    icon: 'telegram',
    domains: Object.entries(answers).map(([profile, ips]) => ({
      hostname: 'example.test',
      answers: { [profile]: ips }
    }))
  }
}

const PROFILES: HostsDnsProfile[] = [
  { id: 'cloudflare', name: 'Cloudflare', order: 0 },
  { id: 'google', name: 'Google', order: 1 }
]

describe('leaf-only config patches (R2)', () => {
  it('wraps only the changed tgws leaf', () => {
    const patch = tgwsPatch({ autoStart: true })
    expect(patch).toEqual({ tgws: { autoStart: true } })
    expect(Object.keys(patch)).toEqual(['tgws'])
    expect(Object.keys(patch.tgws ?? {})).toEqual(['autoStart'])
  })

  it('can express clearing activeStrategy without copying the section', () => {
    const patch = zapretPatch({ activeStrategy: undefined })
    expect(Object.keys(patch)).toEqual(['zapret'])
    expect(patch.zapret).toHaveProperty('activeStrategy', undefined)
    expect(Object.keys(patch.zapret ?? {})).toEqual(['activeStrategy'])
  })

  it('keeps a multi-leaf wallpaper change limited to the supplied leaves', () => {
    const patch = wallpaperPatch({ enabled: true, source: 'video', path: 'C:\\wall.mp4' })
    expect(patch).toEqual({
      wallpaper: { enabled: true, source: 'video', path: 'C:\\wall.mp4' }
    })
    // No stale defaults from a full `{ ...wallpaper, ...next }` copy.
    expect(patch.wallpaper).not.toHaveProperty('opacity')
    expect(patch.wallpaper).not.toHaveProperty('blur')
    expect(patch.wallpaper).not.toHaveProperty('dim')
  })
})

describe('update-check gates (R3)', () => {
  it('uses a 15 minute deduping window', () => {
    expect(UPDATE_DEDUPING_MS).toBe(15 * 60 * 1000)
  })

  it('never checks before the config is loaded', () => {
    expect(shouldAutoCheckUpdates('app', undefined)).toBe(false)
    expect(shouldAutoCheckUpdates('zapret', undefined)).toBe(false)
    expect(shouldAutoCheckUpdates('tgws', undefined)).toBe(false)
  })

  it('follows app.autoCheckUpdate', () => {
    expect(shouldAutoCheckUpdates('app', appConfig())).toBe(true)
    expect(shouldAutoCheckUpdates('app', appConfig({ autoCheckUpdate: false }))).toBe(false)
  })

  it('follows zapret.checkUpdates and defaults to enabled', () => {
    expect(shouldAutoCheckUpdates('zapret', appConfig())).toBe(true)
    expect(
      shouldAutoCheckUpdates('zapret', appConfig({ zapret: { enabled: false, checkUpdates: false } }))
    ).toBe(false)
    expect(
      shouldAutoCheckUpdates('zapret', appConfig({ zapret: { enabled: false, checkUpdates: true } }))
    ).toBe(true)
  })

  it('auto-checks TgWs whenever the config is available', () => {
    expect(shouldAutoCheckUpdates('tgws', appConfig())).toBe(true)
  })

  it('hides a banner without a tag, after dismissal, or after the session X', () => {
    const base = { hasUpdate: true, tag: 'v1.2.0' }
    expect(updateBannerVisible(undefined)).toBe(false)
    expect(updateBannerVisible({ hasUpdate: false, tag: 'v1.2.0' })).toBe(false)
    expect(updateBannerVisible({ hasUpdate: true })).toBe(false)
    expect(updateBannerVisible(base)).toBe(true)
    expect(updateBannerVisible({ ...base, dismissed: true })).toBe(false)
    expect(updateBannerVisible(base, true)).toBe(false)
  })

  it('persists the tag the matching main-process updater compares', () => {
    // App updater compares `dismissedAppUpdateTag` with the release tag.
    expect(updateDismissTag('app', { tag: 'v1.5.0', latest: '1.5.0' })).toBe('v1.5.0')
    expect(updateDismissTag('app', { latest: '1.5.0' })).toBe('1.5.0')
    // Component updaters compare with the cached release version.
    expect(updateDismissTag('zapret', { tag: 'v1.10.4', latest: '1.10.4' })).toBe('1.10.4')
    expect(updateDismissTag('tgws', { tag: 'v1.11.4' })).toBe('v1.11.4')
    expect(updateDismissTag('zapret', {})).toBeUndefined()
  })
})

describe('manual check reveal (R3)', () => {
  it('un-hides a dismissed component update after an explicit check', () => {
    const info = { hasUpdate: true, tag: 'v1.0.0', dismissed: true }
    expect(revealAfterManualCheck('zapret', info)).toMatchObject({ dismissed: false })
    expect(revealAfterManualCheck('app', info)).toBe(info)
    expect(revealAfterManualCheck('tgws', { hasUpdate: false, dismissed: true }).dismissed).toBe(
      true
    )
  })
})

describe('hosts DNS profile fallback (R21)', () => {
  it('detects profiles with at least one answer', () => {
    const service = dnsService({ cloudflare: ['1.1.1.1'] })
    expect(hasAnswers(service, 'cloudflare')).toBe(true)
    expect(hasAnswers(service, 'google')).toBe(false)
  })

  it('keeps the pinned hosts mode for non-DNS services', () => {
    const service: HostsService = {
      id: 'direct',
      name: 'Direct',
      category: 'direct',
      kind: 'hosts',
      order: 0,
      icon: 'x',
      entries: []
    }
    expect(defaultProfileFor(service, PROFILES)).toBe('hosts')
  })

  it('prefers the requested profile when it has answers', () => {
    const service = dnsService({ cloudflare: ['1.1.1.1'], google: ['8.8.8.8'] })
    expect(defaultProfileFor(service, PROFILES, 'google')).toBe('google')
  })

  it('falls back to off instead of a profile with zero answers', () => {
    const service = dnsService({})
    const result = defaultProfileFor(service, PROFILES, 'cloudflare')
    expect(result).toBe('off')
    expect(result).not.toBe(PROFILES[0].id)
  })

  it('includes the stored profile in the select options even without answers', () => {
    const service = dnsService({})
    const options = profileOptionsFor(service, PROFILES, 'cloudflare')
    expect(options.map((profile) => profile.id)).toContain('cloudflare')
  })

  it('includes an explicit off option so the displayed value matches state', () => {
    const service = dnsService({})
    const options = profileOptionsFor(service, PROFILES, 'off')
    expect(options[0]).toMatchObject({ id: 'off' })
  })

  it('limits options to profiles with answers when any exist', () => {
    const service = dnsService({ cloudflare: ['1.1.1.1'] })
    expect(profileOptionsFor(service, PROFILES, 'cloudflare').map((p) => p.id)).toEqual([
      'cloudflare'
    ])
  })
})