import { describe, expect, it, vi } from 'vitest'
import { renameWithRetry } from '@main/utils/fs-retry'

function errno(code: string): NodeJS.ErrnoException {
  const error = new Error(`${code}: simulated`) as NodeJS.ErrnoException
  error.code = code
  return error
}

describe('renameWithRetry', () => {
  it('retries EBUSY and succeeds on the third attempt', async () => {
    let calls = 0
    const rename = vi.fn(async () => {
      calls += 1
      if (calls <= 2) throw errno('EBUSY')
    })
    const sleep = vi.fn(async () => undefined)

    await renameWithRetry('from', 'to', { rename, sleep })

    expect(rename).toHaveBeenCalledTimes(3)
    expect(sleep).toHaveBeenCalledTimes(2)
    expect(sleep).toHaveBeenCalledWith(100)
    expect(rename).toHaveBeenLastCalledWith('from', 'to')
  })

  it.each(['EPERM', 'EACCES'])('retries %s as well', async (code) => {
    let calls = 0
    const rename = vi.fn(async () => {
      calls += 1
      if (calls === 1) throw errno(code)
    })

    await renameWithRetry('from', 'to', { rename, sleep: async () => undefined })
    expect(rename).toHaveBeenCalledTimes(2)
  })

  it('does not retry a permanent error', async () => {
    const rename = vi.fn(async () => {
      throw errno('ENOENT')
    })
    const sleep = vi.fn(async () => undefined)

    await expect(renameWithRetry('from', 'to', { rename, sleep })).rejects.toThrow(/ENOENT/)
    expect(rename).toHaveBeenCalledTimes(1)
    expect(sleep).not.toHaveBeenCalled()
  })

  it('gives up after five attempts and rethrows the last error', async () => {
    const rename = vi.fn(async () => {
      throw errno('EPERM')
    })

    await expect(
      renameWithRetry('from', 'to', { rename, sleep: async () => undefined })
    ).rejects.toMatchObject({ code: 'EPERM' })
    expect(rename).toHaveBeenCalledTimes(5)
  })

  it('respects a custom attempt count', async () => {
    const rename = vi.fn(async () => {
      throw errno('EBUSY')
    })
    await expect(
      renameWithRetry('from', 'to', { rename, attempts: 2, sleep: async () => undefined })
    ).rejects.toMatchObject({ code: 'EBUSY' })
    expect(rename).toHaveBeenCalledTimes(2)
  })
})
