import { readFileSync } from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { validateHostsCatalog } from '@main/core/hosts-catalog'
import { renderManagedBlock } from '@main/core/hosts-render'

/**
 * The Roblox launcher loads game covers from `tr.rbxcdn.com`. In networks where
 * that name is poisoned the covers disappear, so the catalog ships the verified
 * CDN addresses as a normal "direct" hosts preset the user can toggle.
 */
const VERIFIED_ROBLOX_IPS = [
  '18.65.39.105',
  '18.64.211.78',
  '18.64.211.88',
  '18.64.211.103',
  '18.64.211.77',
  '65.8.158.112',
  '23.47.124.101'
]

const catalog = validateHostsCatalog(
  JSON.parse(readFileSync(path.resolve(process.cwd(), 'resources/hosts-catalog.json'), 'utf8'))
)

describe('Roblox covers hosts preset', () => {
  it('ships tr.rbxcdn.com as a direct hosts service', () => {
    const service = catalog.services.find((item) => item.id === 'hosts.roblox')

    expect(service).toBeDefined()
    expect(service?.kind).toBe('hosts')
    expect(service?.category).toBe('direct')
    expect(service?.entries).toEqual([
      { hostname: 'tr.rbxcdn.com', ips: VERIFIED_ROBLOX_IPS }
    ])
  })

  it('renders one managed hosts line per verified address', () => {
    const rendered = renderManagedBlock(catalog, {
      version: 1,
      catalogVersion: catalog.meta.version,
      selection: { 'hosts.roblox': 'hosts' },
      defaultDnsProfile: catalog.dnsProfiles[0]?.id ?? '',
      adobeBlock: false
    })

    expect(rendered.services).toBe(1)
    expect(rendered.lines).toBe(VERIFIED_ROBLOX_IPS.length)
    for (const ip of VERIFIED_ROBLOX_IPS) {
      expect(rendered.content).toContain(`${ip} tr.rbxcdn.com`)
    }
  })

  it('writes nothing while the preset is disabled', () => {
    const rendered = renderManagedBlock(catalog, {
      version: 1,
      catalogVersion: catalog.meta.version,
      selection: { 'hosts.roblox': 'off' },
      defaultDnsProfile: catalog.dnsProfiles[0]?.id ?? '',
      adobeBlock: false
    })

    expect(rendered.content).toBe('')
  })
})
