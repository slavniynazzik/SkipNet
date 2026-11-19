import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { sysBin, windowsRoot } from '@main/utils/sys-bin'

describe('sysBin', () => {
  it('resolves system tools to an absolute System32 path', () => {
    const cmd = sysBin('cmd.exe')
    expect(path.isAbsolute(cmd)).toBe(true)
    expect(cmd.toLowerCase()).toBe(
      path.join(windowsRoot(), 'System32', 'cmd.exe').toLowerCase()
    )
    expect(cmd.toLowerCase()).toContain(`${path.sep}system32${path.sep}`.toLowerCase())
  })

  it('resolves PowerShell 5.1 to its versioned directory', () => {
    const ps = sysBin('powershell.exe')
    expect(path.isAbsolute(ps)).toBe(true)
    expect(ps.toLowerCase()).toContain(`${path.sep}system32${path.sep}`.toLowerCase())
    expect(ps.toLowerCase()).toContain(`${path.sep}windowspowershell${path.sep}`.toLowerCase())
    expect(ps.toLowerCase()).toContain(`${path.sep}v1.0${path.sep}`.toLowerCase())
  })

  it('keeps windowsRoot restricted to a Windows directory', () => {
    const saved = process.env.SystemRoot
    try {
      process.env.SystemRoot = 'C:\\Windows\\\\'
      expect(windowsRoot()).toBe('C:\\Windows')
      process.env.SystemRoot = 'C:\\Temp'
      expect(windowsRoot()).toBe('C:\\Windows')
      process.env.SystemRoot = 'D:\\WINNT'
      expect(windowsRoot()).toBe('D:\\WINNT')
    } finally {
      if (saved === undefined) delete process.env.SystemRoot
      else process.env.SystemRoot = saved
    }
  })

  it('rejects a name with a path component', () => {
    expect(() => sysBin('..\\evil.exe')).toThrow(/invalid/)
    expect(() => sysBin('sub\\cmd.exe')).toThrow(/invalid/)
  })
})
