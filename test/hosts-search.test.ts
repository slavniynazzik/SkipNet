/**
 * Unit tests for the hosts search predicate (R10).
 *
 * Pure module — no React/SWR imports, so it runs in the node vitest env.
 */
import { describe, expect, it } from 'vitest'
import { matchesService } from '../src/renderer/src/lib/hosts-search'

const HOSTS_SERVICE: HostsService = {
  id: 'hosts.discord',
  name: 'Discord',
  category: 'direct',
  kind: 'hosts',
  order: 0,
  icon: 'fa5b.discord',
  entries: [{ hostname: 'gateway.discord.gg', ips: ['1.2.3.4'] }]
}

const DNS_SERVICE: HostsService = {
  id: 'dns.chatgpt_and_sora_openai',
  name: 'ChatGPT / Sora',
  category: 'ai',
  kind: 'dns',
  order: 1,
  icon: 'fa5b.globe',
  domains: [
    {
      hostname: 'chatgpt.com',
      answers: { cloudflare: ['104.18.32.47'] }
    }
  ]
}

describe('matchesService (R10)', () => {
  it('matches everything for an empty or whitespace query', () => {
    expect(matchesService(HOSTS_SERVICE, '')).toBe(true)
    expect(matchesService(DNS_SERVICE, '   ')).toBe(true)
  })

  it('matches the display name case-insensitively', () => {
    expect(matchesService(HOSTS_SERVICE, 'discord')).toBe(true)
    expect(matchesService(HOSTS_SERVICE, 'DISCORD')).toBe(true)
    expect(matchesService(HOSTS_SERVICE, 'DisCoRd')).toBe(true)
  })

  it('matches the service id', () => {
    expect(matchesService(HOSTS_SERVICE, 'hosts.discord')).toBe(true)
    expect(matchesService(DNS_SERVICE, 'sora_openai')).toBe(true)
  })

  it('matches a substring of a hosts entry hostname', () => {
    expect(matchesService(HOSTS_SERVICE, 'gateway')).toBe(true)
    expect(matchesService(HOSTS_SERVICE, 'DISCORD.GG')).toBe(true)
  })

  it('matches a substring of a DNS domain hostname', () => {
    expect(matchesService(DNS_SERVICE, 'chatgpt')).toBe(true)
    expect(matchesService(DNS_SERVICE, 'CHATGPT.COM')).toBe(true)
  })

  it('trims the query before matching', () => {
    expect(matchesService(HOSTS_SERVICE, '  discord  ')).toBe(true)
  })

  it('returns false when nothing matches', () => {
    expect(matchesService(HOSTS_SERVICE, 'telegram')).toBe(false)
    expect(matchesService(DNS_SERVICE, 'not-a-domain')).toBe(false)
  })

  it('handles services without entries or domains', () => {
    const empty: HostsService = {
      id: 'dns.empty',
      name: 'Empty',
      category: 'other',
      kind: 'dns',
      order: 2,
      icon: 'fa5b.globe'
    }
    expect(matchesService(empty, 'empty')).toBe(true)
    expect(matchesService(empty, 'anything')).toBe(false)
  })
})
