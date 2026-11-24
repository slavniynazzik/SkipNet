import { describe, expect, it } from 'vitest'
import { summarizeZapretLists } from '@main/core/zapret-lists'

/**
 * The card header and the update summary must agree. Historically the header
 * counted only `list-general.txt` while the update box counted all four host
 * files, so the same bundle showed "60" and "221" at the same time.
 */
describe('summarizeZapretLists', () => {
  const general = ['discord.com', 'youtube.com', 'telegram.org'].join('\r\n')
  const exclude = ['discord.com', 'example.net'].join('\r\n')
  const google = ['google.com', '# comment', ''].join('\r\n')
  const ipsetExclude = ['1.1.1.1/32'].join('\r\n')
  const user = ['custom.example.org', 'discord.com'].join('\r\n')
  const ipset = ['203.0.113.113/32'].join('\r\n')

  it('reports managed entries, unique hosts and the active IP count', () => {
    expect(
      summarizeZapretLists({
        hostTexts: [general, exclude, google, ipsetExclude],
        userHostTexts: [user],
        ipsetText: ipset,
        ipsetBackupText: '',
        ipsetMode: 'none'
      })
    ).toEqual({
      // 3 + 2 + 1 + 1 — invalid lines and comments are not entries.
      hostEntries: 7,
      // discord.com appears twice; user-only entries are included.
      uniqueHostEntries: 7,
      ipsetEntries: 1,
      ipsetBackupEntries: 0,
      ipsetMode: 'none'
    })
  })

  it('counts the parked IP list separately from the active placeholder', () => {
    const backup = ['10.0.0.0/8', '2001:db8::/32', 'not-a-cidr'].join('\r\n')
    const summary = summarizeZapretLists({
      hostTexts: [general],
      userHostTexts: [],
      ipsetText: ipset,
      ipsetBackupText: backup,
      ipsetMode: 'none'
    })

    expect(summary.ipsetEntries).toBe(1)
    expect(summary.ipsetBackupEntries).toBe(2)
    expect(summary.ipsetMode).toBe('none')
  })

  it('is stable for an empty bundle', () => {
    expect(
      summarizeZapretLists({
        hostTexts: [''],
        userHostTexts: [],
        ipsetText: '',
        ipsetBackupText: '',
        ipsetMode: 'loaded'
      })
    ).toEqual({
      hostEntries: 0,
      uniqueHostEntries: 0,
      ipsetEntries: 0,
      ipsetBackupEntries: 0,
      ipsetMode: 'loaded'
    })
  })
})
