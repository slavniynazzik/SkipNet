import { afterEach, describe, expect, it } from 'vitest'
import {
  collectShortcutRegistrations,
  getFailedShortcuts,
  setFailedShortcuts,
  type ShortcutBinding
} from '@main/resolve/shortcut-status'

const noop = (): void => undefined

afterEach(() => setFailedShortcuts([]))

describe('collectShortcutRegistrations', () => {
  it('separates registered and rejected accelerators', () => {
    const bindings: ShortcutBinding[] = [
      { accelerator: 'CommandOrControl+Shift+1', handler: noop },
      { accelerator: 'CommandOrControl+Shift+2', handler: noop }
    ]
    const result = collectShortcutRegistrations(bindings, (accel) => accel.endsWith('1'))
    expect(result.registered).toEqual(['CommandOrControl+Shift+1'])
    expect(result.failed).toEqual(['CommandOrControl+Shift+2'])
  })

  it('treats a throwing register as a failure', () => {
    const result = collectShortcutRegistrations([{ accelerator: 'Bad+Key', handler: noop }], () => {
      throw new Error('already taken')
    })
    expect(result).toEqual({ registered: [], failed: ['Bad+Key'] })
  })

  it('skips empty or whitespace accelerators', () => {
    const result = collectShortcutRegistrations(
      [
        { accelerator: '', handler: noop },
        { accelerator: '   ', handler: noop },
        { accelerator: ' CommandOrControl+K ', handler: noop }
      ],
      () => true
    )
    expect(result.registered).toEqual(['CommandOrControl+K'])
    expect(result.failed).toEqual([])
  })

  it('treats a non-boolean return as failure', () => {
    const result = collectShortcutRegistrations(
      [{ accelerator: 'A', handler: noop }],
      (() => undefined) as unknown as () => boolean
    )
    expect(result.failed).toEqual(['A'])
  })
})

describe('failed shortcut store', () => {
  it('round-trips a copy of the list', () => {
    const source = ['Ctrl+Alt+1']
    setFailedShortcuts(source)
    source.push('mutated')
    expect(getFailedShortcuts()).toEqual(['Ctrl+Alt+1'])
  })
})
