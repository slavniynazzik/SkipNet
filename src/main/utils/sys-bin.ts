/**
 * Absolute paths to Windows system utilities (L2).
 *
 * Spawning a bare `cmd.exe` / `powershell.exe` / `taskkill.exe` makes the child
 * search PATH — and Windows checks the *current working directory* first. The
 * Electron main process can be spawned with `cwd` inside a user-writable folder
 * (a shortcut's "Start in", the portable unpack dir, an installer temp dir), so
 * a planted `cmd.exe` next to the app would run elevated. Every call site must
 * therefore pass an absolute `%SystemRoot%\System32\…` path.
 *
 * `windowsRoot()` keeps the existing hardening: the environment cannot redirect
 * a privileged spawn to an arbitrary directory.
 */

import path from 'node:path'

const DEFAULT_WINDOWS_ROOT = 'C:\\Windows'

/** `%SystemRoot%` restricted to a local `X:\Windows` / `X:\WINNT` layout. */
export function windowsRoot(): string {
  const raw = (process.env.SystemRoot || process.env.windir || DEFAULT_WINDOWS_ROOT).replace(
    /[\\/]+$/,
    ''
  )
  return /^[a-z]:\\(?:Windows|WINNT)$/i.test(raw) ? raw : DEFAULT_WINDOWS_ROOT
}

/**
 * Resolve a system tool name to its absolute System32 path.
 *
 * `powershell.exe` is the one exception: PowerShell 5.1 lives in
 * `System32\WindowsPowerShell\v1.0\`, not at the System32 root. Anything that
 * still needs `wscript.exe` gets the regular System32 path.
 */
export function sysBin(name: string): string {
  if (!name || /[\\/]/.test(name) || name.includes('..') || name.includes('\0')) {
    throw new Error(`sysBin: invalid system tool name: "${name}"`)
  }
  if (/^powershell\.exe$/i.test(name)) {
    return path.join(windowsRoot(), 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe')
  }
  return path.join(windowsRoot(), 'System32', name)
}
