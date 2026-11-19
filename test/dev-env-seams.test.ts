import { app } from 'electron'
import { afterEach, describe, expect, it } from 'vitest'
import { hostsCatalogRemoteUrl } from '@main/core/hosts-catalog'
import { upstreamBase } from '@main/core/zapret-lists'

// The Electron typings mark `isPackaged` read-only; the suite's stub is
// mutable and `resetElectronMock` restores it to `true` before every test.
const mockApp = app as unknown as { isPackaged: boolean }

const DEFAULT_CATALOG =
  'https://raw.githubusercontent.com/slavniynazzik/SkipNet/main/resources/hosts-catalog.json'
const DEFAULT_LISTS =
  'https://raw.githubusercontent.com/Flowseal/zapret-discord-youtube/refs/heads/main'

afterEach(() => {
  delete process.env.SKIPNET_HOSTS_CATALOG_URL
  delete process.env.SKIPNET_ZAPRET_LISTS_BASE
  mockApp.isPackaged = true
})

describe('dev-only SKIPNET_* seams', () => {
  it('ignores catalog and list overrides in a packaged build (B5 / W16)', () => {
    process.env.SKIPNET_HOSTS_CATALOG_URL = 'https://evil.example/catalog.json'
    process.env.SKIPNET_ZAPRET_LISTS_BASE = 'https://evil.example/lists'
    mockApp.isPackaged = true

    expect(hostsCatalogRemoteUrl()).toBe(DEFAULT_CATALOG)
    expect(upstreamBase()).toBe(DEFAULT_LISTS)
  })

  it('honours the overrides in a dev / unpacked build', () => {
    process.env.SKIPNET_HOSTS_CATALOG_URL = 'https://mock.local/catalog.json'
    process.env.SKIPNET_ZAPRET_LISTS_BASE = 'https://mock.local/lists/'
    mockApp.isPackaged = false

    expect(hostsCatalogRemoteUrl()).toBe('https://mock.local/catalog.json')
    // Trailing slashes are normalised away before path concatenation.
    expect(upstreamBase()).toBe('https://mock.local/lists')
  })

  it('falls back to the defaults for empty values', () => {
    process.env.SKIPNET_HOSTS_CATALOG_URL = '   '
    process.env.SKIPNET_ZAPRET_LISTS_BASE = '   '
    mockApp.isPackaged = false

    expect(hostsCatalogRemoteUrl()).toBe(DEFAULT_CATALOG)
    expect(upstreamBase()).toBe(DEFAULT_LISTS)
  })
})
