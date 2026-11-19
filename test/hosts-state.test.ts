import { rmSync, writeFileSync } from 'node:fs'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  defaultHostsState,
  hostsStatePath,
  loadHostsState,
  normalizeHostsState,
  saveHostsState
} from '@main/core/hosts-state'

function catalog(): HostsCatalog {
  return {
    meta: {
      version: 'cat-7',
      sha256: 'deadbeef',
      createdAt: '2026-01-01T00:00:00Z',
      schemaVersion: 1,
      source: 'unit-test'
    },
    dnsProfiles: [
      { id: 'geohide', name: 'GeoHide', order: 1 },
      { id: 'alt', name: 'Alt', order: 2 }
    ],
    services: [
      {
        id: 'discord',
        name: 'Discord',
        category: 'other',
        kind: 'dns',
        order: 1,
        icon: '',
        domains: [
          {
            hostname: 'discord.com',
            answers: { geohide: ['1.1.1.1'], alt: ['2.2.2.2'] }
          },
          {
            hostname: 'gateway.discord.gg',
            answers: { geohide: ['3.3.3.3'], alt: [] }
          }
        ]
      },
      {
        id: 'telegram',
        name: 'Telegram',
        category: 'other',
        kind: 'hosts',
        order: 2,
        icon: '',
        entries: [{ hostname: 't.me', ips: ['4.4.4.4'] }]
      },
      {
        id: 'alt-only',
        name: 'Alt only',
        category: 'ai',
        kind: 'dns',
        order: 3,
        icon: '',
        domains: [{ hostname: 'alt.example', answers: { alt: ['5.5.5.5'] } }]
      }
    ]
  }
}

afterEach(() => {
  rmSync(hostsStatePath(), { force: true })
})

describe('defaultHostsState', () => {
  it('starts every service off and selects the geohide profile', () => {
    const state = defaultHostsState(catalog())

    expect(state.selection).toEqual({ discord: 'off', telegram: 'off', 'alt-only': 'off' })
    expect(state.defaultDnsProfile).toBe('geohide')
    expect(state.version).toBe(1)
    expect(state.catalogVersion).toBe('cat-7')
    expect(state.adobeBlock).toBe(false)
  })
})

describe('normalizeHostsState', () => {
  it('drops unknown services and defaults new ones to off', () => {
    const state = normalizeHostsState(
      { selection: { discord: 'geohide', ghost: 'hosts' } },
      catalog()
    )

    expect(state.selection).toEqual({ discord: 'geohide', telegram: 'off', 'alt-only': 'off' })
    expect('ghost' in state.selection).toBe(false)
  })

  it('normalizes selections for hosts-kind services', () => {
    expect(
      normalizeHostsState({ selection: { telegram: 'hosts' } }, catalog()).selection.telegram
    ).toBe('hosts')
    expect(
      normalizeHostsState({ selection: { telegram: 'geohide' } }, catalog()).selection.telegram
    ).toBe('off')
    expect(
      normalizeHostsState({ selection: { telegram: 'off' } }, catalog()).selection.telegram
    ).toBe('off')
  })

  it('keeps valid DNS profile selections', () => {
    expect(
      normalizeHostsState({ selection: { discord: 'alt' } }, catalog()).selection.discord
    ).toBe('alt')
    expect(
      normalizeHostsState({ selection: { discord: 'geohide' } }, catalog()).selection.discord
    ).toBe('geohide')
  })

  it('falls back to a profile that actually has answers', () => {
    // `geohide` is a real profile id but has no answers for alt-only, so the
    // normalizer must move to `alt` instead of rendering an empty block.
    expect(
      normalizeHostsState({ selection: { 'alt-only': 'geohide' } }, catalog()).selection[
        'alt-only'
      ]
    ).toBe('alt')
    // An unknown profile id falls back to the default profile when it has answers.
    expect(
      normalizeHostsState({ selection: { discord: 'ghost' } }, catalog()).selection.discord
    ).toBe('geohide')
  })

  it('keeps a valid default profile and replaces an invalid one', () => {
    expect(
      normalizeHostsState({ defaultDnsProfile: 'alt' }, catalog()).defaultDnsProfile
    ).toBe('alt')
    expect(
      normalizeHostsState({ defaultDnsProfile: 'ghost' }, catalog()).defaultDnsProfile
    ).toBe('geohide')
  })

  it.each([null, undefined, 42, 'string'])(
    'returns defaults for non-object input %j',
    (input) => {
      expect(normalizeHostsState(input, catalog())).toEqual(defaultHostsState(catalog()))
    }
  )

  it('normalizes an array payload to the default selection', () => {
    // Arrays are objects, so they reach the normalizer; with no `selection`
    // key every service must still end up off.
    expect(normalizeHostsState([], catalog())).toMatchObject(defaultHostsState(catalog()))
  })

  it('drops invalid skippedIps, trims values and removes duplicates', () => {
    const state = normalizeHostsState(
      {
        skippedIps: ['1.2.3.4', 'not-an-ip', ' 5.6.7.8 ', '1.2.3.4', '::1', '', 7]
      },
      catalog()
    )

    expect(state.skippedIps).toEqual(['1.2.3.4', '5.6.7.8', '::1'])
  })

  it('normalizes resolvedIps: IPv4 only, lowercase keys, dedupe and a cap of four', () => {
    const state = normalizeHostsState(
      {
        resolvedIps: {
          'Discord.COM': ['1.1.1.1', '1.1.1.1', ' 2.2.2.2 ', '3.3.3.3', '4.4.4.4', '5.5.5.5'],
          bad_host: ['1.1.1.1'],
          'v6.example.com': ['2001:db8::1'],
          'empty.example.com': [],
          'junk.example.com': [42, '6.6.6.6']
        }
      },
      catalog()
    )

    expect(state.resolvedIps).toEqual({
      'discord.com': ['1.1.1.1', '2.2.2.2', '3.3.3.3', '4.4.4.4'],
      'junk.example.com': ['6.6.6.6']
    })
  })

  it('ignores a resolvedIps value that is not a plain object', () => {
    expect(
      normalizeHostsState({ resolvedIps: ['1.1.1.1'] as never }, catalog()).resolvedIps
    ).toEqual({})
  })

  it('keeps restoreSelection only for known services and valid selections', () => {
    const state = normalizeHostsState(
      {
        restoreSelection: {
          discord: 'alt',
          telegram: 'hosts',
          'alt-only': 'geohide',
          ghost: 'hosts',
          duplicated: 'off'
        }
      },
      catalog()
    )

    expect(state.restoreSelection).toEqual({
      discord: 'alt',
      telegram: 'hosts',
      'alt-only': 'geohide'
    })
  })

  it('drops a hosts service restore value that is not "hosts"', () => {
    const state = normalizeHostsState(
      { restoreSelection: { telegram: 'geohide' } },
      catalog()
    )

    expect(state.restoreSelection).toEqual({})
  })

  it('coerces adobeBlock to a strict boolean', () => {
    expect(normalizeHostsState({ adobeBlock: true }, catalog()).adobeBlock).toBe(true)
    expect(
      normalizeHostsState({ adobeBlock: 'true' as never }, catalog()).adobeBlock
    ).toBe(false)
  })

  it('passes through string metadata and drops other types', () => {
    const withMeta = normalizeHostsState(
      {
        resolvedAt: '2026-02-01T00:00:00Z',
        appliedAt: '2026-02-02T00:00:00Z',
        renderedHash: 'abc',
        catalogVersion: 'ignored'
      },
      catalog()
    )
    expect(withMeta.resolvedAt).toBe('2026-02-01T00:00:00Z')
    expect(withMeta.appliedAt).toBe('2026-02-02T00:00:00Z')
    expect(withMeta.renderedHash).toBe('abc')
    expect(withMeta.catalogVersion).toBe('cat-7')

    const withBadMeta = normalizeHostsState(
      { resolvedAt: 5 as never, appliedAt: null as never, renderedHash: [] as never },
      catalog()
    )
    expect(withBadMeta.resolvedAt).toBeUndefined()
    expect(withBadMeta.appliedAt).toBeUndefined()
    expect(withBadMeta.renderedHash).toBeUndefined()
  })
})

describe('loadHostsState', () => {
  it('returns defaults when the state file does not exist', () => {
    expect(loadHostsState(catalog())).toEqual(defaultHostsState(catalog()))
  })

  it('reads a BOM-prefixed JSON file and normalizes it', () => {
    writeFileSync(
      hostsStatePath(),
      `\uFEFF${JSON.stringify({
        selection: { discord: 'alt' },
        defaultDnsProfile: 'alt'
      })}`,
      'utf8'
    )

    const state = loadHostsState(catalog())
    expect(state.selection.discord).toBe('alt')
    expect(state.defaultDnsProfile).toBe('alt')
  })

  it('falls back to defaults for corrupt JSON without throwing', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    writeFileSync(hostsStatePath(), '{ this is not json', 'utf8')

    expect(() => loadHostsState(catalog())).not.toThrow()
    expect(loadHostsState(catalog())).toEqual(defaultHostsState(catalog()))
    expect(warn).toHaveBeenCalled()
  })
})

describe('saveHostsState', () => {
  it('writes atomically and reads back the same normalized state', async () => {
    const state: HostsState = {
      ...defaultHostsState(catalog()),
      selection: { discord: 'alt', telegram: 'hosts', 'alt-only': 'off' },
      skippedIps: ['1.2.3.4']
    }

    await saveHostsState(state)

    const loaded = loadHostsState(catalog())
    expect(loaded.selection).toEqual(state.selection)
    expect(loaded.skippedIps).toEqual(['1.2.3.4'])
    expect(hostsStatePath().endsWith('hosts-state.json')).toBe(true)
  })
})
