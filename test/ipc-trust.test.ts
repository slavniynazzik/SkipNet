import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { describe, expect, it } from 'vitest'
import { isTrustedFrameUrl } from '@main/utils/ipc-trust'

const prodIndexPath = path.resolve('out', 'renderer', 'index.html')
const prodIndexUrl = pathToFileURL(prodIndexPath).href
const devUrl = 'http://localhost:5173'

const packaged = { prodIndexPath }
const dev = { devUrl, prodIndexPath }

describe('isTrustedFrameUrl', () => {
  it('accepts the exact file:// URL of our own index.html', () => {
    expect(isTrustedFrameUrl(prodIndexUrl, packaged)).toBe(true)
  })

  it('accepts hash routes on our own index.html (HashRouter)', () => {
    expect(isTrustedFrameUrl(`${prodIndexUrl}#/settings`, packaged)).toBe(true)
  })

  it('rejects any other file:// URL', () => {
    expect(isTrustedFrameUrl('file:///C:/tmp/evil.html', packaged)).toBe(false)
    expect(isTrustedFrameUrl(pathToFileURL(path.resolve('tmp', 'evil.html')).href, packaged)).toBe(
      false
    )
  })

  it('accepts the exact dev origin and its sub-paths', () => {
    expect(isTrustedFrameUrl(devUrl, dev)).toBe(true)
    expect(isTrustedFrameUrl(`${devUrl}/`, dev)).toBe(true)
    expect(isTrustedFrameUrl(`${devUrl}/#/home`, dev)).toBe(true)
  })

  it('rejects a different dev port, scheme or host', () => {
    expect(isTrustedFrameUrl('http://localhost:9999/', dev)).toBe(false)
    expect(isTrustedFrameUrl('https://localhost:5173/', dev)).toBe(false)
    expect(isTrustedFrameUrl('http://127.0.0.1:5173/', dev)).toBe(false)
  })

  it('rejects userinfo tricks that only look like the dev origin', () => {
    expect(isTrustedFrameUrl('http://localhost:5173@evil.com/', dev)).toBe(false)
    expect(isTrustedFrameUrl('http://localhost:5173.evil.com/', dev)).toBe(false)
  })

  it('rejects localhost when no dev URL is configured (packaged)', () => {
    expect(isTrustedFrameUrl('http://localhost:9999/', packaged)).toBe(false)
    expect(isTrustedFrameUrl(devUrl, packaged)).toBe(false)
  })

  it('rejects about:, data: and blob: URLs', () => {
    expect(isTrustedFrameUrl('about:blank', dev)).toBe(false)
    expect(isTrustedFrameUrl('about:blank', packaged)).toBe(false)
    expect(isTrustedFrameUrl('data:text/html,<script>alert(1)</script>', dev)).toBe(false)
    expect(isTrustedFrameUrl('blob:http://localhost:5173/abc', dev)).toBe(false)
  })

  it('rejects malformed and empty input', () => {
    expect(isTrustedFrameUrl('', packaged)).toBe(false)
    expect(isTrustedFrameUrl('not a url', dev)).toBe(false)
    expect(isTrustedFrameUrl('http://', dev)).toBe(false)
    expect(isTrustedFrameUrl(null, dev)).toBe(false)
    expect(isTrustedFrameUrl(undefined, packaged)).toBe(false)
  })

  it('fails closed when the dev URL itself is malformed', () => {
    expect(isTrustedFrameUrl('http://localhost:5173/', { devUrl: '::::', prodIndexPath })).toBe(
      false
    )
  })
})
