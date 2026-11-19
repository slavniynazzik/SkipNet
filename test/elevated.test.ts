import { describe, expect, it } from 'vitest'
import {
  UAC_CANCELLED_EXIT_CODE,
  UAC_CANCELLED_MARKER,
  buildElevatedLauncher,
  classifyElevatedResult,
  encodePowerShellCommand,
  psQuote
} from '@main/utils/elevated'

const PS = 'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe'

describe('buildElevatedLauncher', () => {
  const script = buildElevatedLauncher(PS, 'QUJD')

  it('waits for the elevated process instead of the launcher', () => {
    expect(script).toContain('-Verb RunAs')
    // Without -PassThru there is no process object, and without -Wait the
    // launcher returns before the elevated script ran.
    expect(script).toContain('-PassThru')
    expect(script).toContain('-Wait')
  })

  it('returns the elevated exit code, not PowerShell.exe\u2019s own code', () => {
    expect(script).toContain('exit $p.ExitCode')
    // The launcher created the process itself, so `$p` is guaranteed to exist.
    expect(script).toMatch(/\$p = Start-Process[^\r\n]*-PassThru -Wait/)
  })

  it('reports a dismissed UAC prompt with a distinguishable marker', () => {
    expect(script).toContain(UAC_CANCELLED_MARKER)
    expect(script).toContain(`exit ${UAC_CANCELLED_EXIT_CODE}`)
  })

  it('quotes the powershell path and passes the encoded body verbatim', () => {
    const odd = 'C:\\Program Files\\Power Shell\\powershell.exe'
    const built = buildElevatedLauncher(odd, 'UABTA==')
    expect(built).toContain(psQuote(odd))
    expect(built).toContain(`'-EncodedCommand','UABTA=='`)
  })
})

describe('encodePowerShellCommand', () => {
  it('produces UTF-16LE with a BOM so Cyrillic paths survive', () => {
    const body = "Write-Output 'C:\\Папка'"
    const decoded = Buffer.from(encodePowerShellCommand(body), 'base64').toString('utf16le')
    expect(decoded.startsWith('\uFEFF')).toBe(true)
    expect(decoded).toContain('Папка')
  })
})

describe('classifyElevatedResult', () => {
  it('treats exit code 0 as success', () => {
    expect(classifyElevatedResult({ exitCode: 0 })).toMatchObject({
      ok: true,
      outcome: 'success',
      exitCode: 0
    })
  })

  it('treats any non-zero elevated exit as a failure', () => {
    const result = classifyElevatedResult({
      exitCode: 1,
      stderr: 'Copy-Item : Access denied\r\n'
    })
    expect(result.ok).toBe(false)
    expect(result.outcome).toBe('failed')
    expect(result.stderr).toContain('Access denied')
  })

  it('detects an explicitly cancelled UAC prompt by marker', () => {
    const result = classifyElevatedResult({
      exitCode: 1,
      stderr: `${UAC_CANCELLED_MARKER}: The operation was canceled by the user.`
    })
    expect(result).toMatchObject({ ok: false, outcome: 'uac-cancelled' })
  })

  it('detects ERROR_CANCELLED even without the marker', () => {
    expect(
      classifyElevatedResult({ exitCode: UAC_CANCELLED_EXIT_CODE }).outcome
    ).toBe('uac-cancelled')
  })

  it('treats a spawn error as a failure with a message', () => {
    const result = classifyElevatedResult({
      exitCode: null,
      error: 'spawnSync powershell.exe ETIMEDOUT'
    })
    expect(result.ok).toBe(false)
    expect(result.outcome).toBe('failed')
    expect(result.stderr).toContain('ETIMEDOUT')
  })
})
