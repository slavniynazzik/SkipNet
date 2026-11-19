import { existsSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  defaultHostsState,
  hostsStatePath,
  loadHostsState,
  loadHostsStateRecovering
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
      }
    ]
  }
}

const HOSTS_WITH_BLOCK = [
  '127.0.0.1 localhost',
  '# --- SkipNet hosts editor BEGIN ---',
  '1.1.1.1 discord.com',
  '4.4.4.4 t.me',
  '# --- SkipNet hosts editor END ---',
  ''
].join('\r\n')

function cleanupProfile(): void {
  const file = hostsStatePath()
  rmSync(file, { force: true })
  try {
    for (const entry of readdirSync(path.dirname(file))) {
      if (/^hosts-state\.corrupt-.*\.json$/.test(entry)) {
        rmSync(path.join(path.dirname(file), entry), { force: true })
      }
    }
  } catch {
    /* directory does not exist yet */
  }
}

afterEach(cleanupProfile)

describe('loadHostsStateRecovering', () => {
  it('returns the parsed state and no recovery marker for a healthy file', async () => {
    writeFileSync(
      hostsStatePath(),
      JSON.stringify({ selection: { discord: 'alt' }, defaultDnsProfile: 'alt' }),
      'utf8'
    )

    const result = await loadHostsStateRecovering(catalog(), {
      hostsContent: HOSTS_WITH_BLOCK
    })

    expect(result.recovery).toBeUndefined()
    expect(result.state.selection.discord).toBe('alt')
    // A healthy state file must not be rebuilt from the hosts block.
    expect(result.state.selection.telegram).toBe('off')
  })

  it('moves a corrupt file aside and rebuilds the selection from the managed block', async () => {
    const broken = '{ this is not json'
    writeFileSync(hostsStatePath(), broken, 'utf8')

    const result = await loadHostsStateRecovering(catalog(), {
      hostsContent: HOSTS_WITH_BLOCK
    })

    expect(result.recovery?.recovered).toBe(true)
    expect(result.recovery?.warning).toMatch(/восстановлено по блоку/i)
    expect(result.recovery?.corruptPath).toBeTruthy()

    // The corrupt bytes are preserved for inspection.
    expect(existsSync(result.recovery!.corruptPath!)).toBe(true)
    expect(readFileSync(result.recovery!.corruptPath!, 'utf8')).toBe(broken)

    // Both a pinned service and a DNS service are mapped back from the block.
    expect(result.state.selection.telegram).toBe('hosts')
    expect(result.state.selection.discord).toBe('geohide')
    expect(result.state.renderedHash).toBeTruthy()

    // The rebuilt state is persisted, so a later synchronous read agrees.
    const reloaded = loadHostsState(catalog())
    expect(reloaded.selection.telegram).toBe('hosts')
    expect(reloaded.selection.discord).toBe('geohide')
  })

  it('falls back to defaults when the hosts file has no usable block', async () => {
    writeFileSync(hostsStatePath(), 'not-json', 'utf8')

    const result = await loadHostsStateRecovering(catalog(), {
      hostsContent: '127.0.0.1 localhost\r\n'
    })

    expect(result.recovery?.recovered).toBe(true)
    expect(result.recovery?.warning).toMatch(/по умолчанию/i)
    expect(result.state).toEqual(defaultHostsState(catalog()))
  })

  it('recovers with no hosts content at all (unreadable/unavailable hosts)', async () => {
    writeFileSync(hostsStatePath(), 'not-json', 'utf8')

    const result = await loadHostsStateRecovering(catalog())

    expect(result.recovery?.recovered).toBe(true)
    expect(result.state).toEqual(defaultHostsState(catalog()))
  })

  it('returns defaults without a recovery marker when the file does not exist', async () => {
    const result = await loadHostsStateRecovering(catalog(), {
      hostsContent: HOSTS_WITH_BLOCK
    })

    expect(result.recovery).toBeUndefined()
    expect(result.state).toEqual(defaultHostsState(catalog()))
  })
})
