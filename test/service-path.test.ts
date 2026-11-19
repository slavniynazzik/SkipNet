import { describe, expect, it } from 'vitest'
import {
  hasReplacementChar,
  sameServiceImagePath,
  serviceImageBasename
} from '@main/utils/service-path'

describe('serviceImageBasename', () => {
  it('takes the file name and lowercases it', () => {
    expect(serviceImageBasename('C:\\SkipNet\\resources\\zapret\\bin\\WinDivert64.SYS')).toBe(
      'windivert64.sys'
    )
    expect(serviceImageBasename('C:/SkipNet/WinDivert64.sys')).toBe('windivert64.sys')
  })

  it('strips the NT prefix and surrounding quotes', () => {
    expect(serviceImageBasename('\\??\\C:\\Windows\\System32\\drivers\\WinDivert.sys')).toBe(
      'windivert.sys'
    )
    expect(serviceImageBasename('"C:\\Path With Spaces\\WinDivert64.sys"')).toBe(
      'windivert64.sys'
    )
  })
})

describe('sameServiceImagePath', () => {
  it('compares only the file name, case-insensitively', () => {
    expect(
      sameServiceImagePath(
        'C:\\Program Files\\SkipNet\\resources\\zapret\\bin\\windivert64.sys',
        'D:\\Zapret\\bin\\WinDivert64.sys'
      )
    ).toBe(true)
  })

  it('detects a different driver file', () => {
    expect(
      sameServiceImagePath('C:\\Zapret\\bin\\WinDivert.sys', 'C:\\Zapret\\bin\\WinDivert64.sys')
    ).toBe(false)
  })

  it('treats an empty path as not matching', () => {
    expect(sameServiceImagePath('', 'C:\\Zapret\\bin\\WinDivert64.sys')).toBe(false)
  })
})

describe('hasReplacementChar', () => {
  it('flags lossy OEM decoding', () => {
    expect(hasReplacementChar('C:\\Пользователи\\\uFFFD\\WinDivert64.sys')).toBe(true)
  })

  it('does not flag a clean Cyrillic path', () => {
    expect(hasReplacementChar('C:\\Пользователи\\Иван\\WinDivert64.sys')).toBe(false)
    expect(hasReplacementChar(null)).toBe(false)
  })
})
