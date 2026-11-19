import { describe, expect, it } from 'vitest'
import { redactSecrets } from '@main/utils/redact'

const HEX32 = '0123456789abcdef0123456789abcdef'
const HEX32_UPPER = '0123456789ABCDEF0123456789ABCDEF'

describe('redactSecrets', () => {
  it('masks --secret <value> (separate argument)', () => {
    const out = redactSecrets(`spawning: TgWsProxy.exe --secret ${HEX32} --port 1443`)

    expect(out).not.toContain(HEX32)
    expect(out).toContain('--secret <redacted>')
    expect(out).toContain('--port 1443')
  })

  it('masks --secret=<value> and quoted values', () => {
    expect(redactSecrets(`run --secret=${HEX32}`)).toBe('run --secret=<redacted>')
    expect(redactSecrets('run --secret "top secret value"')).toBe(
      'run --secret <redacted>'
    )
  })

  it('masks secret=<hex> query parameters', () => {
    const out = redactSecrets(`GET /?server=1.2.3.4&port=443&secret=${HEX32}&x=1`)

    expect(out).not.toContain(HEX32)
    expect(out).toContain('secret=<redacted>')
    expect(out).toContain('x=1')
  })

  it('masks the secret inside a tg://proxy link', () => {
    const link = `tg://proxy?server=127.0.0.1&port=1443&secret=${HEX32}`
    const out = redactSecrets(`link: ${link}`)

    expect(out).not.toContain(HEX32)
    expect(out).toBe('link: tg://proxy?server=127.0.0.1&port=1443&secret=<redacted>')
  })

  it('masks standalone 32-hex tokens in both cases', () => {
    expect(redactSecrets(`token ${HEX32} leaked`)).toBe('token <redacted> leaked')
    expect(redactSecrets(`token ${HEX32_UPPER} leaked`)).toBe('token <redacted> leaked')
  })

  it('masks exact secret values passed by the caller', () => {
    const out = redactSecrets('user typed Swordfish-42 in the field', ['Swordfish-42'])

    expect(out).toBe('user typed <redacted> in the field')
  })

  it('masks JSON `"secret": "..."` payloads', () => {
    const out = redactSecrets(`{"host":"127.0.0.1","secret":"${HEX32}"}`)

    expect(out).not.toContain(HEX32)
    expect(out).toContain('"secret":"<redacted>"')
  })

  it('does not mangle sha256 digests or short hex ids', () => {
    const sha = 'a'.repeat(64)
    const short = 'deadbeef'

    expect(redactSecrets(`sha256:${sha}`)).toBe(`sha256:${sha}`)
    expect(redactSecrets(`id ${short}`)).toBe(`id ${short}`)
  })

  it('leaves text without secrets untouched', () => {
    const text = 'zapret started (pid=4242) — 22 strategies'

    expect(redactSecrets(text)).toBe(text)
    expect(redactSecrets('')).toBe('')
  })

  it('ignores short exact secrets so log lines stay readable', () => {
    expect(redactSecrets('path /a/b/c', ['a'])).toBe('path /a/b/c')
  })

  it('masks every occurrence', () => {
    const out = redactSecrets(`${HEX32} ${HEX32} secret=${HEX32}`)

    expect(out).not.toContain(HEX32)
    expect(out.match(/<redacted>/g)?.length).toBe(3)
  })
})
