/**
 * Review item: renderer input is untrusted. A malformed IP-list patch must be
 * rejected with a user-facing message instead of failing inside `.flatMap`
 * with an opaque `TypeError`.
 */
import { describe, expect, it } from 'vitest'
import { applyIpListPatch, type IpListPatch } from '@main/core/zapret-iplist'

function call(patch: unknown): void {
  applyIpListPatch(patch as IpListPatch)
}

describe('applyIpListPatch validation', () => {
  it('rejects a non-array customCidrs', () => {
    expect(() => call({ customCidrs: 'discord.com' })).toThrow(/customCidrs.*массивом строк/)
  })

  it('rejects a non-string item', () => {
    expect(() => call({ customCidrs: ['ok.example', 42] })).toThrow(
      /customCidrs\[1\].*строкой/
    )
  })

  it('validates customHosts the same way', () => {
    expect(() => call({ customHosts: { host: 'x' } })).toThrow(/customHosts.*массивом строк/)
  })

  it('rejects malformed setIds and replace', () => {
    expect(() => call({ setIds: 'discord' })).toThrow(/setIds.*массивом строк/)
    expect(() => call({ replace: 'yes' })).toThrow(/replace.*true или false/)
  })
})
