/**
 * B3 review item: a failed config write must not leave `getAppConfig()`
 * reporting a value that never reached disk.
 */
import { afterEach, describe, expect, it, vi } from 'vitest'

const state = vi.hoisted(() => ({ failRename: false }))

vi.mock('@main/utils/fs-retry', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@main/utils/fs-retry')>()
  return {
    ...actual,
    renameWithRetry: async (
      from: string,
      to: string,
      options?: Parameters<typeof actual.renameWithRetry>[2]
    ): Promise<void> => {
      if (state.failRename) {
        throw Object.assign(new Error('disk full'), { code: 'ENOSPC' })
      }
      return actual.renameWithRetry(from, to, options)
    }
  }
})

import { getAppConfig, patchAppConfig } from '@main/config'

afterEach(() => {
  state.failRename = false
})

describe('patchAppConfig rollback', () => {
  it('restores the in-memory snapshot when safeWriteConfig fails', async () => {
    const before = await getAppConfig(true)
    const baseline = before.maxLogDays
    const next = baseline === 12 ? 13 : 12

    state.failRename = true
    await expect(patchAppConfig({ maxLogDays: next })).rejects.toThrow('disk full')

    // The rejected value must not be visible through the normal reader.
    const afterFailure = await getAppConfig()
    expect(afterFailure.maxLogDays).toBe(baseline)

    // The queue recovers: the next successful patch is applied and persisted.
    state.failRename = false
    await patchAppConfig({ maxLogDays: baseline })
    expect((await getAppConfig()).maxLogDays).toBe(baseline)
  })
})
