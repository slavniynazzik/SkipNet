import { readFileSync } from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { MEDIA_SCHEME_PRIVILEGES } from '@main/core/wallpaper'

describe('skipnet-media protocol privileges (C11 / P1-14)', () => {
  it('never bypasses the renderer CSP', () => {
    expect(MEDIA_SCHEME_PRIVILEGES.bypassCSP).toBe(false)
  })

  it('keeps the privileges the wallpaper flow needs', () => {
    expect(MEDIA_SCHEME_PRIVILEGES).toEqual({
      standard: true,
      secure: true,
      supportFetchAPI: true,
      stream: true,
      bypassCSP: false
    })
  })
})

describe('renderer CSP', () => {
  const html = readFileSync(
    path.join(process.cwd(), 'src', 'renderer', 'index.html'),
    'utf8'
  )
  const csp = /http-equiv="Content-Security-Policy"[\s\S]*?content="([^"]+)"/.exec(html)?.[1] ?? ''

  function directive(name: string): string {
    const match = new RegExp(`(?:^|;)\\s*${name}\\s+([^;]+)`).exec(csp)
    return match?.[1]?.trim() ?? ''
  }

  it('keeps skipnet-media: for images and media', () => {
    expect(directive('img-src')).toContain('skipnet-media:')
    expect(directive('media-src')).toContain('skipnet-media:')
    expect(directive('img-src')).toContain('data:')
    expect(directive('media-src')).toContain('blob:')
  })

  it('does not allow file: images or media', () => {
    expect(directive('img-src')).not.toContain('file:')
    expect(directive('media-src')).not.toContain('file:')
  })

  it('keeps the rest of the CSP strict', () => {
    expect(csp).toContain("object-src 'none'")
    expect(csp).toContain("base-uri 'none'")
    expect(csp).toContain("form-action 'none'")
    expect(csp).not.toContain('unsafe-eval')
    expect(csp).not.toContain('*')
  })
})
