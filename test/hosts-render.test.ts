import { describe, expect, it } from 'vitest'
import {
  ADOBE_BLOCK_END,
  ADOBE_BLOCK_START,
  EDITOR_BLOCK_END,
  EDITOR_BLOCK_START,
  LEGACY_SKIPNET_END,
  LEGACY_SKIPNET_START,
  assertBalancedBlocks,
  buildHostsContent,
  countEditorBlockLines,
  detectLegacyBlocks,
  effectiveEntryIps,
  extractBlock,
  hashHostsContent,
  parseAdobeEntries,
  parseEditorBlock,
  parseLegacySkipNet,
  renderAdobeBlock,
  renderManagedBlock,
  stripManagedBlocks,
  validateHostsFileContent
} from '@main/core/hosts-render'

const ZAPRETGUI_START = '# >>> zapretgui:hosts managed begin >>>'
const ZAPRETGUI_END = '# <<< zapretgui:hosts managed end <<<'

function catalog(): HostsCatalog {
  return {
    meta: {
      version: 'test-1',
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
            answers: { geohide: ['1.1.1.1', '2.2.2.2'], alt: ['3.3.3.3'] }
          },
          { hostname: 'gateway.discord.gg', answers: { geohide: ['4.4.4.4'], alt: [] } }
        ]
      },
      {
        id: 'telegram',
        name: 'Telegram',
        category: 'other',
        kind: 'hosts',
        order: 2,
        icon: '',
        entries: [
          { hostname: 'telegram.org', ips: ['5.5.5.5', '6.6.6.6'] },
          { hostname: 't.me', ips: ['7.7.7.7'] }
        ]
      },
      {
        id: 'ai',
        name: 'AI',
        category: 'ai',
        kind: 'dns',
        order: 3,
        icon: '',
        domains: [{ hostname: 'chatgpt.com', answers: { geohide: ['8.8.8.8'] } }]
      }
    ]
  }
}

function state(overrides: Partial<HostsState> = {}): HostsState {
  return {
    version: 1,
    catalogVersion: 'test-1',
    selection: { discord: 'geohide', telegram: 'hosts', ai: 'off' },
    defaultDnsProfile: 'geohide',
    adobeBlock: false,
    ...overrides
  }
}

describe('buildHostsContent -> parseEditorBlock round-trip', () => {
  it('parses back exactly the pairs that were rendered, in order', () => {
    const rendered = renderManagedBlock(catalog(), state())
    const content = buildHostsContent('', rendered, '', false, new Set())

    expect(parseEditorBlock(content)).toEqual([
      { ip: '1.1.1.1', hostname: 'discord.com' },
      { ip: '2.2.2.2', hostname: 'discord.com' },
      { ip: '4.4.4.4', hostname: 'gateway.discord.gg' },
      { ip: '5.5.5.5', hostname: 'telegram.org' },
      { ip: '6.6.6.6', hostname: 'telegram.org' },
      { ip: '7.7.7.7', hostname: 't.me' }
    ])
    expect(rendered.services).toBe(2)
    expect(rendered.lines).toBe(6)
  })

  it('is idempotent: rebuilding over its own output changes nothing', () => {
    const rendered = renderManagedBlock(catalog(), state())
    const once = buildHostsContent('', rendered, '', false, new Set())
    const twice = buildHostsContent(once, rendered, '', false, new Set())

    expect(twice).toBe(once)
  })

  it('keeps catalog order stable across repeated renders', () => {
    const first = renderManagedBlock(catalog(), state()).content
    const second = renderManagedBlock(catalog(), state()).content

    expect(second).toBe(first)
    expect(first.indexOf('# >>> SkipNet service: discord')).toBeLessThan(
      first.indexOf('# >>> SkipNet service: telegram')
    )
    expect(first.indexOf('4.4.4.4 gateway.discord.gg')).toBeLessThan(
      first.indexOf('5.5.5.5 telegram.org')
    )
  })

  it('collapses a duplicate (ip, hostname) pair written by several services', () => {
    const sharedCatalog: HostsCatalog = {
      meta: { ...catalog().meta },
      dnsProfiles: [{ id: 'geohide', name: 'GeoHide', order: 1 }],
      services: [
        {
          id: 'a',
          name: 'A',
          category: 'other',
          kind: 'hosts',
          order: 1,
          icon: '',
          entries: [{ hostname: 'same.example', ips: ['1.2.3.4'] }]
        },
        {
          id: 'b',
          name: 'B',
          category: 'other',
          kind: 'hosts',
          order: 2,
          icon: '',
          entries: [
            { hostname: 'same.example', ips: ['1.2.3.4'] },
            { hostname: 'other.example', ips: ['5.6.7.8'] }
          ]
        },
        {
          id: 'c',
          name: 'C',
          category: 'other',
          kind: 'hosts',
          order: 3,
          icon: '',
          entries: [{ hostname: 'same.example', ips: ['1.2.3.4'] }]
        }
      ]
    }

    const rendered = renderManagedBlock(sharedCatalog, {
      ...state(),
      selection: { a: 'hosts', b: 'hosts', c: 'hosts' }
    })

    expect(rendered.content.match(/1\.2\.3\.4 same\.example/g)).toHaveLength(1)
    // Service C only repeats a pair that is already present, so it is dropped.
    expect(rendered.services).toBe(2)
    expect(rendered.lines).toBe(2)
  })

  it('omits skipped addresses and services that lose all of their addresses', () => {
    const rendered = renderManagedBlock(
      catalog(),
      state({ skippedIps: ['2.2.2.2', '4.4.4.4'] })
    )

    expect(rendered.content).toContain('1.1.1.1 discord.com')
    expect(rendered.content).not.toContain('2.2.2.2 discord.com')
    expect(rendered.content).not.toContain('gateway.discord.gg')
  })

  it('uses verified resolvedIps instead of the frozen catalog addresses', () => {
    const rendered = renderManagedBlock(
      catalog(),
      state({ resolvedIps: { 'discord.com': ['9.9.9.9'] } })
    )

    expect(rendered.content).toContain('9.9.9.9 discord.com')
    expect(rendered.content).not.toContain('1.1.1.1 discord.com')
    // Hostnames without an override keep the catalog addresses.
    expect(rendered.content).toContain('4.4.4.4 gateway.discord.gg')
  })

  it('warns when the selected profile has no addresses for a domain', () => {
    const rendered = renderManagedBlock(
      catalog(),
      state({ selection: { discord: 'alt', telegram: 'off', ai: 'off' } })
    )

    expect(rendered.warnings).toContain('Discord: нет адресов для профиля alt')
  })
})

describe('effectiveEntryIps', () => {
  it('prefers resolvedIps over the fallback and lowercases the lookup key', () => {
    const current = state({ resolvedIps: { 'discord.com': ['10.0.0.1'] } })

    expect(effectiveEntryIps(current, 'Discord.COM', ['1.1.1.1'])).toEqual(['10.0.0.1'])
    expect(effectiveEntryIps(current, 'other.example', ['2.2.2.2'])).toEqual(['2.2.2.2'])
  })

  it('falls back when the override list is present but empty', () => {
    const current = state({ resolvedIps: { 'discord.com': [] } })

    expect(effectiveEntryIps(current, 'discord.com', ['1.1.1.1'])).toEqual(['1.1.1.1'])
  })
})

describe('assertBalancedBlocks', () => {
  it('accepts a well-formed file with several independent blocks', () => {
    const content = [
      `${EDITOR_BLOCK_START}`,
      '1.1.1.1 discord.com',
      `${EDITOR_BLOCK_END}`,
      `${ADOBE_BLOCK_START}`,
      '127.0.0.1 adobe.com',
      `${ADOBE_BLOCK_END}`,
      ZAPRETGUI_START,
      '2.2.2.2 example.com',
      ZAPRETGUI_END
    ].join('\r\n')

    expect(() => assertBalancedBlocks(content)).not.toThrow()
  })

  it('throws on a duplicate END marker', () => {
    const content = [EDITOR_BLOCK_START, EDITOR_BLOCK_END, EDITOR_BLOCK_END].join('\n')

    expect(() => assertBalancedBlocks(content)).toThrow(/без начала/)
  })

  it('throws on a BEGIN marker without a matching END', () => {
    const content = [EDITOR_BLOCK_START, '1.1.1.1 discord.com'].join('\n')

    expect(() => assertBalancedBlocks(content)).toThrow(/не закрыт/)
  })

  it('throws when END appears before BEGIN', () => {
    expect(() => assertBalancedBlocks(EDITOR_BLOCK_END)).toThrow(/без начала/)
  })

  it('throws on a nested duplicate BEGIN', () => {
    const content = [EDITOR_BLOCK_START, EDITOR_BLOCK_START, EDITOR_BLOCK_END].join('\n')

    expect(() => assertBalancedBlocks(content)).toThrow(/не закрыт/)
  })

  it('throws when a block is closed by a different block marker', () => {
    const content = [EDITOR_BLOCK_START, ADOBE_BLOCK_END].join('\n')

    expect(() => assertBalancedBlocks(content)).toThrow(/без начала/)
  })
})

describe('stripManagedBlocks', () => {
  it('preserves unrelated lines byte-for-byte, including comments and trailing spaces', () => {
    const original = [
      '# my custom comment',
      '127.0.0.1 localhost',
      '',
      '   # indented note',
      '10.0.0.1 intranet.example   ',
      EDITOR_BLOCK_START,
      '1.1.1.1 discord.com',
      EDITOR_BLOCK_END,
      '192.168.1.5 nas.local'
    ].join('\r\n')

    expect(stripManagedBlocks(original, new Set())).toBe(
      [
        '# my custom comment',
        '127.0.0.1 localhost',
        '',
        '   # indented note',
        '10.0.0.1 intranet.example   ',
        '192.168.1.5 nas.local'
      ].join('\r\n')
    )
  })

  it('removes legacy SkipNet, ZapretGUI, Adobe and orphan lines', () => {
    const adobeHosts = new Set(['adobe.com'])
    const original = [
      '127.0.0.1 localhost',
      LEGACY_SKIPNET_START,
      '1.1.1.1 legacy.example',
      LEGACY_SKIPNET_END,
      ZAPRETGUI_START,
      '2.2.2.2 zapretgui.example',
      ZAPRETGUI_END,
      ADOBE_BLOCK_START,
      '127.0.0.1 adobe.com',
      ADOBE_BLOCK_END,
      '127.0.0.1 adobe.com',
      '# adobe activation block',
      '3.3.3.3 kept.example'
    ].join('\r\n')

    expect(stripManagedBlocks(original, adobeHosts)).toBe(
      ['127.0.0.1 localhost', '3.3.3.3 kept.example'].join('\r\n')
    )
  })

  it('does not treat a partial block as owned and refuses to strip it', () => {
    const content = [EDITOR_BLOCK_START, '1.1.1.1 discord.com'].join('\r\n')

    expect(() => stripManagedBlocks(content, new Set())).toThrow(/не закрыт/)
  })
})

describe('hashHostsContent', () => {
  it('is stable when the same logical file is rebuilt from CRLF, LF or BOM input', () => {
    const rendered = renderManagedBlock(catalog(), state())
    const lf = '# comment\n1.1.1.1 unrelated.example\n'
    const crlfBom = `\uFEFF# comment\r\n1.1.1.1 unrelated.example\r\n`

    const fromLf = buildHostsContent(lf, rendered, '', false, new Set())
    const fromCrlf = buildHostsContent(crlfBom, rendered, '', false, new Set())

    expect(fromCrlf).toBe(fromLf)
    expect(hashHostsContent(fromCrlf)).toBe(hashHostsContent(fromLf))
  })

  it('is deterministic for identical content', () => {
    expect(hashHostsContent('1.1.1.1 a.example\r\n')).toBe(
      hashHostsContent('1.1.1.1 a.example\r\n')
    )
  })

  it('is byte-exact, so a real edit produces a different hash', () => {
    expect(hashHostsContent('1.1.1.1 a.example\r\n')).not.toBe(
      hashHostsContent('1.1.1.1 a.example\r\n1.1.1.1 b.example\r\n')
    )
    expect(hashHostsContent('a\r\nb')).not.toBe(hashHostsContent('a\nb'))
  })

  it('treats a latin1 BOM as part of the hashed bytes', () => {
    expect(hashHostsContent('\u00ef\u00bb\u00bf1.1.1.1 a.example')).not.toBe(
      hashHostsContent('1.1.1.1 a.example')
    )
  })
})

describe('Adobe block render/parse', () => {
  it('renders and parses its own block', () => {
    const adobe = renderAdobeBlock(['adobe.com', 'photoshop.adobe.com'])

    expect(adobe.startsWith(ADOBE_BLOCK_START)).toBe(true)
    expect(adobe.endsWith(ADOBE_BLOCK_END)).toBe(true)
    expect(parseAdobeEntries(adobe, new Set(['adobe.com', 'photoshop.adobe.com']))).toEqual([
      { ip: '127.0.0.1', hostname: 'adobe.com' },
      { ip: '127.0.0.1', hostname: 'photoshop.adobe.com' }
    ])
  })

  it('returns an empty string when there is nothing to render', () => {
    expect(renderAdobeBlock([])).toBe('')
  })

  it('adds the Adobe block only when enabled and strips it when disabled', () => {
    const rendered = renderManagedBlock(catalog(), state())
    const adobe = renderAdobeBlock(['adobe.com'])
    const adobeHosts = new Set(['adobe.com'])

    const withAdobe = buildHostsContent('', rendered, adobe, true, adobeHosts)
    expect(withAdobe).toContain(ADOBE_BLOCK_START)
    expect(parseAdobeEntries(withAdobe, adobeHosts)).toHaveLength(1)

    const withoutAdobe = buildHostsContent(withAdobe, rendered, adobe, false, adobeHosts)
    expect(withoutAdobe).not.toContain('adobe.com')
    expect(withoutAdobe).toBe(buildHostsContent('', rendered, '', false, adobeHosts))
  })
})

describe('helpers shared by the hosts editor', () => {
  it('counts only mapping lines inside the managed block', () => {
    const rendered = renderManagedBlock(catalog(), state())

    expect(countEditorBlockLines(rendered.content)).toBe(6)
    expect(countEditorBlockLines('1.1.1.1 outside.example')).toBe(0)
  })

  it('extracts the managed block with its markers', () => {
    const rendered = renderManagedBlock(catalog(), state())
    const block = extractBlock(rendered.content, EDITOR_BLOCK_START, EDITOR_BLOCK_END)

    expect(block.split('\n')[0]).toBe(EDITOR_BLOCK_START)
    expect(block.split('\n').at(-1)).toBe(EDITOR_BLOCK_END)
  })

  it('detects legacy blocks in a foreign hosts file', () => {
    const content = [
      LEGACY_SKIPNET_START,
      '1.1.1.1 legacy.example',
      LEGACY_SKIPNET_END,
      ZAPRETGUI_START,
      '2.2.2.2 zapretgui.example',
      ZAPRETGUI_END,
      '127.0.0.1 adobe.com'
    ].join('\r\n')

    expect(detectLegacyBlocks(content, new Set(['adobe.com']))).toEqual({
      zapretGui: true,
      skipNet: true,
      adobe: true
    })
    expect(parseLegacySkipNet(content)).toEqual([
      { ip: '1.1.1.1', hostname: 'legacy.example' }
    ])
    expect(detectLegacyBlocks('127.0.0.1 localhost', new Set(['adobe.com']))).toEqual({
      zapretGui: false,
      skipNet: false,
      adobe: false
    })
  })

  it('validates a hosts backup and rejects arbitrary command lines', () => {
    const rendered = renderManagedBlock(catalog(), state())

    expect(() => validateHostsFileContent(rendered.content)).not.toThrow()
    expect(() => validateHostsFileContent('cmd.exe /c calc.exe')).toThrow(/Повреждённая строка/)
    expect(() => validateHostsFileContent('1.1.1.1 bad_host')).toThrow(/Повреждённое имя хоста/)
  })
})
