import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  classifyGithubUrl,
  fetchGithubApi,
  fetchReleaseAsset,
  fetchReleaseAssetDirect,
  githubApiUrl,
  releaseAssetDirectCandidates,
  releaseAssetUrlCandidates,
  resolveReleaseDigest,
  type GhAsset,
  type GhRelease
} from '@main/utils/github'

const API_URL = 'https://api.github.com/repos/o/r/releases/latest'
const ASSET_URL = 'https://github.com/o/r/releases/download/v1.0.0/SkipNet_x64.exe'
const OBJECTS_URL =
  'https://objects.githubusercontent.com/github-production-release-asset-2e65be/1/2/3'

afterEach(() => {
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

describe('classifyGithubUrl', () => {
  it('recognises the three GitHub trust domains', () => {
    expect(classifyGithubUrl(API_URL)).toBe('api')
    expect(classifyGithubUrl(ASSET_URL)).toBe('release-asset')
    expect(classifyGithubUrl(OBJECTS_URL)).toBe('asset-redirect')
  })

  it('rejects everything else', () => {
    expect(classifyGithubUrl('https://evil.example/x.exe')).toBe('other')
    expect(classifyGithubUrl('http://github.com/o/r/releases/download/v1.0.0/x.exe')).toBe('other')
    expect(classifyGithubUrl('https://github.com/o/r/archive/v1.0.0.zip')).toBe('other')
    expect(classifyGithubUrl('https://api.github.com.evil.example/repos/o/r')).toBe('other')
    expect(classifyGithubUrl('https://user:pass@github.com/o/r/releases/download/v1/x.exe')).toBe(
      'other'
    )
    expect(classifyGithubUrl('not a url')).toBe('other')
  })
})

describe('releaseAssetUrlCandidates', () => {
  it('never mirrors API metadata', () => {
    expect(releaseAssetUrlCandidates(API_URL)).toEqual([API_URL])
  })

  it('never mirrors an arbitrary host', () => {
    expect(releaseAssetUrlCandidates('https://evil.example/x.exe')).toEqual([
      'https://evil.example/x.exe'
    ])
  })

  it('mirrors the canonical release-download URL only', () => {
    expect(releaseAssetUrlCandidates(ASSET_URL)).toEqual([
      ASSET_URL,
      `https://gh-proxy.com/${ASSET_URL}`,
      `https://ghfast.top/${ASSET_URL}`
    ])
  })

  it('treats objects.githubusercontent.com as a redirect target, not a mirror source', () => {
    expect(classifyGithubUrl(OBJECTS_URL)).toBe('asset-redirect')
    expect(releaseAssetUrlCandidates(OBJECTS_URL)).toEqual([OBJECTS_URL])
  })
})

describe('githubApiUrl', () => {
  it('builds API URLs from a path', () => {
    expect(githubApiUrl('/repos/o/r/releases/tags/v1.0.0')).toBe(
      'https://api.github.com/repos/o/r/releases/tags/v1.0.0'
    )
  })

  it('accepts a full api.github.com URL', () => {
    expect(githubApiUrl(API_URL)).toBe(API_URL)
  })

  it.each([
    'https://evil.example/repos/o/r/releases/latest',
    'http://api.github.com/repos/o/r/releases/latest',
    'https://api.github.com.evil.example/repos/o/r',
    'https://user:pass@api.github.com/repos/o/r',
    '//evil.example/x',
    ''
  ])('rejects %s', (url) => {
    expect(() => githubApiUrl(url)).toThrow()
  })
})

describe('fetchGithubApi', () => {
  it('calls api.github.com exactly once and never a mirror', async () => {
    const fetchMock = vi.fn(async (_input: RequestInfo | URL) => new Response('{}', { status: 200 }))
    vi.stubGlobal('fetch', fetchMock)

    const res = await fetchGithubApi('/repos/o/r/releases/latest')

    expect(res.ok).toBe(true)
    expect(fetchMock).toHaveBeenCalledTimes(1)
    expect(fetchMock.mock.calls[0][0]).toBe('https://api.github.com/repos/o/r/releases/latest')
  })

  it('refuses a non-API URL before any network call', async () => {
    const fetchMock = vi.fn(async (_input: RequestInfo | URL) => new Response('{}', { status: 200 }))
    vi.stubGlobal('fetch', fetchMock)

    await expect(fetchGithubApi('https://evil.example/releases/latest')).rejects.toThrow(
      /api\.github\.com/
    )
    expect(fetchMock).not.toHaveBeenCalled()
  })
})

describe('fetchReleaseAsset', () => {
  it('fetches an unknown host unchanged and does not mirror it', async () => {
    const fetchMock = vi.fn(async (_input: RequestInfo | URL) => new Response('bytes', { status: 200 }))
    vi.stubGlobal('fetch', fetchMock)

    const res = await fetchReleaseAsset('https://evil.example/x.exe')

    expect(res.ok).toBe(true)
    expect(fetchMock).toHaveBeenCalledTimes(1)
    expect(fetchMock.mock.calls[0][0]).toBe('https://evil.example/x.exe')
  })

  it('returns the direct release asset without touching a mirror', async () => {
    const fetchMock = vi.fn(async (_input: RequestInfo | URL) => new Response('bytes', { status: 200 }))
    vi.stubGlobal('fetch', fetchMock)

    await fetchReleaseAsset(ASSET_URL)

    expect(fetchMock).toHaveBeenCalledTimes(1)
    expect(fetchMock.mock.calls[0][0]).toBe(ASSET_URL)
  })

  it('falls back to a mirror only after the canonical URL fails', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(new Response('nope', { status: 502 }))
      .mockResolvedValueOnce(new Response('bytes', { status: 200 }))
    vi.stubGlobal('fetch', fetchMock)

    const res = await fetchReleaseAsset(ASSET_URL)

    expect(res.ok).toBe(true)
    expect(fetchMock).toHaveBeenCalledTimes(2)
    expect(fetchMock.mock.calls[0][0]).toBe(ASSET_URL)
    expect(fetchMock.mock.calls[1][0]).toBe(`https://gh-proxy.com/${ASSET_URL}`)
  })
})

describe('fetchReleaseAssetDirect', () => {
  it('has exactly one candidate: the canonical release URL', () => {
    expect(releaseAssetDirectCandidates(ASSET_URL)).toEqual([ASSET_URL])
  })

  it('refuses a non-release URL before any network call', async () => {
    const fetchMock = vi.fn(async () => new Response('bytes', { status: 200 }))
    vi.stubGlobal('fetch', fetchMock)

    await expect(fetchReleaseAssetDirect(API_URL)).rejects.toThrow(/releases\/download/)
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('fetches the canonical URL once and never falls back to a mirror', async () => {
    const fetchMock = vi.fn(async (_input: RequestInfo | URL) => new Response('sums', { status: 200 }))
    vi.stubGlobal('fetch', fetchMock)

    await expect(fetchReleaseAssetDirect(ASSET_URL)).resolves.toBe('sums')
    expect(fetchMock).toHaveBeenCalledTimes(1)
    expect(fetchMock.mock.calls[0][0]).toBe(ASSET_URL)
  })

  it('fails closed when only a mirror would answer', async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input)
      if (url === ASSET_URL) return new Response('direct down', { status: 502 })
      return new Response('mirror bytes', { status: 200 })
    })
    vi.stubGlobal('fetch', fetchMock)

    await expect(fetchReleaseAssetDirect(ASSET_URL)).rejects.toThrow()
    // The mirror must never be called.
    expect(fetchMock).toHaveBeenCalledTimes(1)
    expect(fetchMock.mock.calls[0][0]).toBe(ASSET_URL)
  })

  it('rejects a redirect away from GitHub', async () => {
    const response = new Response('evil', { status: 200 })
    Object.defineProperty(response, 'url', { value: 'https://evil.example/x' })
    vi.stubGlobal('fetch', vi.fn(async () => response))

    await expect(fetchReleaseAssetDirect(ASSET_URL)).rejects.toThrow(/перенаправлена/)
  })

  it('caps the body size', async () => {
    const body = 'x'.repeat(64)
    vi.stubGlobal('fetch', vi.fn(async () => new Response(body, { status: 200 })))

    await expect(fetchReleaseAssetDirect(ASSET_URL, { maxBytes: 16 })).rejects.toThrow(
      /слишком большой/
    )
  })
})

describe('resolveReleaseDigest', () => {
  const release: GhRelease = {
    tag_name: 'v1.0.0',
    assets: [
      {
        name: 'SkipNet_x64.exe',
        browser_download_url:
          'https://github.com/o/r/releases/download/v1.0.0/SkipNet_x64.exe',
        size: 7,
        digest: null
      },
      {
        name: 'SHA256SUMS.txt',
        browser_download_url:
          'https://github.com/o/r/releases/download/v1.0.0/SHA256SUMS.txt',
        size: 100
      }
    ]
  }
  const asset = release.assets![0] as GhAsset

  it('prefers GitHub-provided asset.digest', async () => {
    const digest = `sha256:${'a'.repeat(64)}`
    await expect(
      resolveReleaseDigest(release, { ...asset, digest }, 'установщика')
    ).resolves.toBe(digest)
  })

  it('falls back to SHA256SUMS.txt from the same release, direct only', async () => {
    const sums = `# checksums\n${'b'.repeat(64)}  SkipNet_x64.exe\n`
    const sumsUrl = release.assets![1].browser_download_url
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      expect(String(input)).toBe(sumsUrl)
      return new Response(sums, { status: 200 })
    })
    vi.stubGlobal('fetch', fetchMock)

    await expect(resolveReleaseDigest(release, asset, 'установщика')).resolves.toBe(
      `sha256:${'b'.repeat(64)}`
    )
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })

  it('does not accept a sums file that only a mirror can serve', async () => {
    const sumsUrl = release.assets![1].browser_download_url
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      if (String(input) === sumsUrl) return new Response('down', { status: 502 })
      return new Response(`${'c'.repeat(64)}  SkipNet_x64.exe\n`, { status: 200 })
    })
    vi.stubGlobal('fetch', fetchMock)

    await expect(resolveReleaseDigest(release, asset, 'установщика')).rejects.toThrow(
      /зеркала не используются/
    )
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })

  it('aborts when neither a digest nor a usable manifest exists', async () => {
    await expect(
      resolveReleaseDigest({ tag_name: 'v1.0.0', assets: [] }, asset, 'установщика')
    ).rejects.toThrow(/установка отменена/)

    const fetchMock = vi.fn(async () => new Response('no entry here\n', { status: 200 }))
    vi.stubGlobal('fetch', fetchMock)
    await expect(resolveReleaseDigest(release, asset, 'установщика')).rejects.toThrow(
      /нет контрольной суммы/
    )
  })
})
