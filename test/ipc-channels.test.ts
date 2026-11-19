import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import {
  EVENT_CHANNELS,
  INVOKE_CHANNELS,
  isEventChannel,
  isInvokeChannel
} from '../src/shared/ipc-channels'

const invoked = [...INVOKE_CHANNELS]
const events = [...EVENT_CHANNELS]

const ipcSource = readFileSync(
  fileURLToPath(new URL('../src/main/utils/ipc.ts', import.meta.url)),
  'utf8'
)

/**
 * Channel keys of the `handlers: Record<InvokeChannel, IpcHandler>` literal.
 * Indented exactly four spaces (inside `registerIpcMainHandlers`) and quoted;
 * nested result objects use unquoted keys at deeper indentation.
 */
const registeredHandlers = [...ipcSource.matchAll(/^ {4}'([^']+)':/gm)].map((match) => match[1])

describe('channel registry', () => {
  it('has no duplicate invoke channels', () => {
    expect(new Set(invoked).size).toBe(invoked.length)
  })

  it('has no duplicate event channels', () => {
    expect(new Set(events).size).toBe(events.length)
  })

  it('does not resurrect removed channels', () => {
    expect(invoked).not.toContain('setLanguage')
    expect(invoked).not.toContain('zapret:installBundle')
    expect(events).not.toContain('setLanguage')
    expect(events).not.toContain('zapret:installBundle')
  })

  it('keeps events and invokes disjoint', () => {
    const invokeSet = new Set<string>(invoked)
    expect(events.filter((channel) => invokeSet.has(channel))).toEqual([])
  })

  it('exposes exactly the nine documented events', () => {
    expect(events.sort()).toEqual(
      [
        'appConfigUpdated',
        'log',
        'showError',
        'tgws:status',
        'window-maximized',
        'window-unmaximized',
        'window:visibility',
        'zapret:status',
        'zapret:testProgress'
      ].sort()
    )
  })

  it('registers exactly the channels the preload allow-list exposes', () => {
    expect(registeredHandlers.length).toBeGreaterThan(0)
    expect(registeredHandlers.sort()).toEqual(invoked.sort())
  })

  it('registers handlers only through the typed map', () => {
    // A stray `ipcMain.handle('literal', ...)` would bypass the
    // `Record<InvokeChannel, ...>` contract, so it must not exist.
    expect(ipcSource).not.toMatch(/ipcMain\.handle\(\s*'/)
  })
})

describe('channel type guards', () => {
  it('accepts every registered channel', () => {
    for (const channel of invoked) expect(isInvokeChannel(channel)).toBe(true)
    for (const channel of events) expect(isEventChannel(channel)).toBe(true)
  })

  it('rejects the other list, unknown names and non-strings', () => {
    for (const channel of events) expect(isInvokeChannel(channel)).toBe(false)
    for (const channel of invoked) expect(isEventChannel(channel)).toBe(false)
    expect(isInvokeChannel('nope')).toBe(false)
    expect(isEventChannel('nope')).toBe(false)
    expect(isInvokeChannel(42)).toBe(false)
    expect(isEventChannel(null)).toBe(false)
  })

  it('is frozen against runtime mutation', () => {
    expect(Object.isFrozen(INVOKE_CHANNELS)).toBe(true)
    expect(Object.isFrozen(EVENT_CHANNELS)).toBe(true)
  })
})
