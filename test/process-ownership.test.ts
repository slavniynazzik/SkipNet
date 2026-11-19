import path from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  TRACKED_PID_CREATION_TOLERANCE_MS,
  hasParentSegment,
  isOwnedImagePath,
  isSameImagePath,
  isTrackedProcessMatch,
  parseCimProcessIdentity,
  parseCimProcessList,
  parseTasklistCsv,
  selectOwnedKillTargets,
  type ProcessEntry,
  type ProcessIdentity,
  type TrackedProcess
} from '@main/core/process-ownership'

const ROOT = path.resolve('C:', 'SkipNet', 'resources', 'zapret')
const TGWS_ROOT = path.resolve('C:', 'SkipNet', 'resources', 'tgws')

describe('isOwnedImagePath', () => {
  it('accepts an executable inside a component root', () => {
    expect(isOwnedImagePath(path.join(ROOT, 'bin', 'winws.exe'), [ROOT])).toBe(true)
    expect(isOwnedImagePath(path.join(TGWS_ROOT, 'TgWsProxy_windows.exe'), [TGWS_ROOT])).toBe(true)
  })

  it('is case-insensitive', () => {
    expect(
      isOwnedImagePath(
        path.join('C:', 'SKIPNET', 'RESOURCES', 'ZAPRET', 'BIN', 'WINWS.EXE'),
        [path.join('c:', 'skipnet', 'resources', 'zapret')]
      )
    ).toBe(true)
  })

  it('treats both separators the same', () => {
    expect(isOwnedImagePath(`${ROOT}/bin/winws.exe`, [ROOT])).toBe(true)
    expect(isOwnedImagePath(path.join(ROOT, 'bin', 'winws.exe'), [`${ROOT}/`])).toBe(true)
  })

  it('rejects a sibling directory that only shares the prefix', () => {
    expect(isOwnedImagePath(`${ROOT}-evil\\winws.exe`, [ROOT])).toBe(false)
  })

  it('rejects a path outside every root', () => {
    expect(isOwnedImagePath(path.resolve('C:', 'Other', 'Zapret', 'winws.exe'), [ROOT])).toBe(false)
  })

  it('rejects a root used directly as an image path', () => {
    expect(isOwnedImagePath(ROOT, [ROOT])).toBe(false)
  })

  it('rejects traversal segments even when they resolve inside a root', () => {
    expect(hasParentSegment(`${ROOT}\\..\\zapret\\bin\\winws.exe`)).toBe(true)
    expect(isOwnedImagePath(`${ROOT}\\..\\zapret\\bin\\winws.exe`, [ROOT])).toBe(false)
  })

  it('rejects empty input and empty roots', () => {
    expect(isOwnedImagePath('', [ROOT])).toBe(false)
    expect(isOwnedImagePath(path.join(ROOT, 'winws.exe'), [])).toBe(false)
  })
})

describe('parseTasklistCsv', () => {
  it('parses quoted rows and skips the informational header', () => {
    const text = [
      'INFO: No tasks are running which match the specified criteria.',
      '"winws.exe","4321","Console","1","12 345 КБ"',
      '"TgWsProxy_windows.exe","99","Services","0","3 000 КБ"'
    ].join('\r\n')
    expect(parseTasklistCsv(text)).toEqual([
      { imageName: 'winws.exe', pid: 4321 },
      { imageName: 'TgWsProxy_windows.exe', pid: 99 }
    ])
  })

  it('unescapes doubled quotes', () => {
    expect(parseTasklistCsv('"odd""name.exe","77","Console","1","1 КБ"')).toEqual([
      { imageName: 'odd"name.exe', pid: 77 }
    ])
  })

  it('ignores rows without a numeric pid', () => {
    expect(parseTasklistCsv('"a.exe","PID","x","0","0"')).toEqual([])
  })
})

describe('parseCimProcessList', () => {
  it('parses pid|path lines and keeps slashes in the path', () => {
    expect(
      parseCimProcessList(
        '123|C:\\SkipNet\\resources\\zapret\\bin\\winws.exe\r\n456|D:\\Tools\\winws.exe\r\n'
      )
    ).toEqual([
      { pid: 123, imagePath: 'C:\\SkipNet\\resources\\zapret\\bin\\winws.exe' },
      { pid: 456, imagePath: 'D:\\Tools\\winws.exe' }
    ])
  })

  it('skips noise and empty paths', () => {
    expect(parseCimProcessList('garbage\n0|x\n12|\n')).toEqual([])
  })
})

describe('isSameImagePath', () => {
  it('compares case and separators, and strips the \\\\?\\ prefix', () => {
    expect(
      isSameImagePath(
        'C:\\WINDOWS\\system32\\CMD.EXE',
        'c:/windows/System32/cmd.exe'
      )
    ).toBe(true)
    expect(
      isSameImagePath('\\\\?\\C:\\Windows\\System32\\cmd.exe', 'C:\\Windows\\System32\\cmd.exe')
    ).toBe(true)
    expect(
      isSameImagePath('C:\\Windows\\System32\\notepad.exe', 'C:\\Windows\\System32\\cmd.exe')
    ).toBe(false)
  })

  it('rejects empty input and traversal segments', () => {
    expect(isSameImagePath('', 'C:\\Windows\\cmd.exe')).toBe(false)
    expect(
      isSameImagePath('C:\\Windows\\..\\Windows\\cmd.exe', 'C:\\Windows\\cmd.exe')
    ).toBe(false)
  })
})

describe('parseCimProcessIdentity', () => {
  it('parses pid, path and creation time', () => {
    expect(
      parseCimProcessIdentity(
        '123|C:\\SkipNet\\resources\\zapret\\bin\\winws.exe|1700000000000\r\n' +
          '456|D:\\Tools\\winws.exe|\r\n'
      )
    ).toEqual([
      {
        pid: 123,
        imagePath: 'C:\\SkipNet\\resources\\zapret\\bin\\winws.exe',
        creationTime: 1700000000000
      },
      { pid: 456, imagePath: 'D:\\Tools\\winws.exe' }
    ])
  })

  it('treats a missing third field as "no creation time"', () => {
    expect(parseCimProcessIdentity('7|C:\\Other\\winws.exe')).toEqual([
      { pid: 7, imagePath: 'C:\\Other\\winws.exe' }
    ])
  })

  it('skips rows without a usable path', () => {
    expect(parseCimProcessIdentity('0|x|1\n5||2\n')).toEqual([])
  })
})

describe('isTrackedProcessMatch (R-12)', () => {
  const tracked = (overrides: Partial<TrackedProcess> = {}): TrackedProcess => ({
    pid: 4242,
    imagePath: path.join(ROOT, 'bin', 'winws.exe'),
    startedAt: 1_700_000_000_000,
    ...overrides
  })
  const actual = (overrides: Partial<ProcessIdentity> = {}): ProcessIdentity => ({
    pid: 4242,
    imagePath: path.join(ROOT, 'bin', 'winws.exe'),
    creationTime: 1_700_000_000_000,
    ...overrides
  })

  it('accepts the same pid, an owned path and a matching start time', () => {
    expect(isTrackedProcessMatch(tracked(), actual(), [ROOT])).toBe(true)
  })

  it('accepts a start time inside the two-second tolerance', () => {
    expect(
      isTrackedProcessMatch(
        tracked(),
        actual({ creationTime: 1_700_000_000_000 + TRACKED_PID_CREATION_TOLERANCE_MS }),
        [ROOT]
      )
    ).toBe(true)
  })

  it('rejects a recycled PID that started later than the tolerance', () => {
    expect(
      isTrackedProcessMatch(
        tracked(),
        actual({ creationTime: 1_700_000_000_000 + TRACKED_PID_CREATION_TOLERANCE_MS + 1 }),
        [ROOT]
      )
    ).toBe(false)
  })

  it('rejects a process whose image is no longer ours', () => {
    expect(
      isTrackedProcessMatch(
        tracked(),
        actual({ imagePath: path.resolve('C:', 'Other', 'winws.exe') }),
        [ROOT]
      )
    ).toBe(false)
  })

  it('accepts the recorded launcher even when it is a system binary', () => {
    // Zapret is started through `cmd.exe /c general.bat`; the launcher lives in
    // System32, outside resources, but it is still the exact image we spawned.
    const cmd = 'C:\\Windows\\System32\\cmd.exe'
    expect(
      isTrackedProcessMatch(
        tracked({ pid: 77, imagePath: cmd }),
        actual({ pid: 77, imagePath: cmd }),
        [ROOT]
      )
    ).toBe(true)
  })

  it('rejects a recycled PID that reused the number with a different image', () => {
    const cmd = 'C:\\Windows\\System32\\cmd.exe'
    expect(
      isTrackedProcessMatch(
        tracked({ pid: 77, imagePath: cmd }),
        actual({ pid: 77, imagePath: 'C:\\Windows\\System32\\notepad.exe' }),
        [ROOT]
      )
    ).toBe(false)
  })

  it('rejects a missing process or a different pid', () => {
    expect(isTrackedProcessMatch(tracked(), undefined, [ROOT])).toBe(false)
    expect(isTrackedProcessMatch(tracked(), actual({ pid: 9 }), [ROOT])).toBe(false)
  })

  it('falls back to the path when Windows exposes no creation time', () => {
    expect(
      isTrackedProcessMatch(tracked(), actual({ creationTime: undefined }), [ROOT])
    ).toBe(true)
  })
})

describe('selectOwnedKillTargets', () => {
  const tracked = (pid: number): TrackedProcess => ({
    pid,
    imagePath: path.join(ROOT, 'bin', 'winws.exe'),
    startedAt: 1
  })
  const entry = (pid: number, imagePath: string): ProcessEntry => ({ pid, imagePath })

  it('prefers tracked pids over the process table', () => {
    expect(
      selectOwnedKillTargets({
        tracked: [tracked(100)],
        enumerated: [entry(200, path.join(ROOT, 'bin', 'winws.exe'))],
        roots: [ROOT]
      })
    ).toEqual([100])
  })

  it('falls back to owned paths when nothing is tracked', () => {
    expect(
      selectOwnedKillTargets({
        tracked: [],
        enumerated: [
          entry(1, path.join(ROOT, 'bin', 'winws.exe')),
          entry(2, path.resolve('C:', 'Other', 'winws.exe'))
        ],
        roots: [ROOT]
      })
    ).toEqual([1])
  })

  it('leaves a foreign image alive when the tracked pid is missing', () => {
    expect(
      selectOwnedKillTargets({
        tracked: [],
        enumerated: [entry(777, path.resolve('C:', 'Other', 'Zapret', 'winws.exe'))],
        roots: [ROOT]
      })
    ).toEqual([])
  })
})
