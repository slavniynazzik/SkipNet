import { spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import { app } from 'electron'
import { is } from '@electron-toolkit/utils'
import { exePath } from '../utils/dirs'
import { sysBin } from '../utils/sys-bin'

const TASK_NAME = 'SkipNetAutoStart'
// Task/Run names used before the rebrand. Removed on every enable/disable so
// an upgraded install cannot keep launching the old binary at login.
const LEGACY_TASK_NAMES = ['SlipgateAutoStart', 'Slipgate Auto Start']
const LEGACY_RUN_VALUES = ['Slipgate']

/** Result of registering/removing the logon task. Never throws to the caller. */
export interface AutoRunResult {
  ok: boolean
  message: string
}

/**
 * Escape a value for use in XML text or a double-quoted attribute.
 *
 * Task Scheduler rejects the whole XML document on a single raw `&` — which is
 * exactly what an install path like `C:\R&D\SkipNet.exe` contains — so every
 * interpolated value goes through this function.
 */
export function escapeXml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;')
}

/** `DOMAIN\User`, with the leading separator removed for a domainless account. */
export function currentUserId(
  env: NodeJS.ProcessEnv = process.env
): string {
  return `${env.USERDOMAIN || ''}\\${env.USERNAME || ''}`.replace(/^\\/, '')
}

/**
 * Refuse to register a task that cannot possibly start. A relative path is
 * resolved by Task Scheduler against %SystemRoot%\System32, and a missing exe
 * would make the task fail silently at every logon.
 */
export function assertAutoRunTarget(exe: string): void {
  if (!path.isAbsolute(exe)) {
    throw new Error(
      `Автозапуск не настроен: путь к SkipNet должен быть абсолютным (получено «${exe}»).`
    )
  }
  if (!existsSync(exe)) {
    throw new Error(
      `Автозапуск не настроен: файл SkipNet.exe не найден по пути «${exe}». ` +
        'Переустановите приложение или запустите его из папки установки.'
    )
  }
}

/** Remove any legacy HKCU\…\Run entry left over from older versions. */
function clearLegacyRunEntry(): void {
  try {
    app.setLoginItemSettings({ openAtLogin: false })
  } catch { /* noop */ }
  for (const hive of ['HKCU', 'HKLM']) {
    for (const value of LEGACY_RUN_VALUES) {
      try {
        const p = spawn(
          sysBin('reg.exe'),
          [
            'delete',
            `${hive}\\Software\\Microsoft\\Windows\\CurrentVersion\\Run`,
            '/v',
            value,
            '/f'
          ],
          { windowsHide: true }
        )
        p.on('error', () => void 0)
        p.unref()
      } catch { /* noop */ }
    }
  }
}

function runSchtasks(args: string[]): Promise<{ code: number; out: string }> {
  return new Promise((resolve) => {
    let out = ''
    const p = spawn(sysBin('schtasks.exe'), args, { windowsHide: true })
    p.stdout?.on('data', (b) => { out += b.toString() })
    p.stderr?.on('data', (b) => { out += b.toString() })
    p.on('exit', (code) => resolve({ code: code ?? 1, out }))
    p.on('error', () => resolve({ code: 1, out }))
  })
}

/**
 * Build the schtasks /Create XML payload. We use XML rather than the
 * /TR/SC short-form because only XML supports `RunLevel=HighestAvailable`
 * + `MultipleInstancesPolicy=IgnoreNew` + delay tweaks in one call.
 *
 * Pure function: `exe` and `userId` are escaped here, and the caller validates
 * the exe before calling. Exported for the XML well-formedness test.
 */
export function buildTaskXml(exe: string, userId: string): string {
  const safeUser = escapeXml(userId)
  const safeExe = escapeXml(exe)
  return `<?xml version="1.0" encoding="UTF-16"?>
<Task version="1.4" xmlns="http://schemas.microsoft.com/windows/2004/02/mit/task">
  <RegistrationInfo>
    <Description>SkipNet auto-launch (TG WS Proxy + Zapret)</Description>
  </RegistrationInfo>
  <Triggers>
    <LogonTrigger>
      <Enabled>true</Enabled>
      <UserId>${safeUser}</UserId>
      <Delay>PT0S</Delay>
    </LogonTrigger>
  </Triggers>
  <Principals>
    <Principal id="Author">
      <UserId>${safeUser}</UserId>
      <LogonType>InteractiveToken</LogonType>
      <RunLevel>HighestAvailable</RunLevel>
    </Principal>
  </Principals>
  <Settings>
    <MultipleInstancesPolicy>IgnoreNew</MultipleInstancesPolicy>
    <DisallowStartIfOnBatteries>false</DisallowStartIfOnBatteries>
    <StopIfGoingOnBatteries>false</StopIfGoingOnBatteries>
    <AllowHardTerminate>true</AllowHardTerminate>
    <StartWhenAvailable>false</StartWhenAvailable>
    <RunOnlyIfNetworkAvailable>false</RunOnlyIfNetworkAvailable>
    <IdleSettings>
      <StopOnIdleEnd>false</StopOnIdleEnd>
      <RestartOnIdle>false</RestartOnIdle>
    </IdleSettings>
    <AllowStartOnDemand>true</AllowStartOnDemand>
    <Enabled>true</Enabled>
    <Hidden>false</Hidden>
    <RunOnlyIfIdle>false</RunOnlyIfIdle>
    <DisallowStartOnRemoteAppSession>false</DisallowStartOnRemoteAppSession>
    <UseUnifiedSchedulingEngine>true</UseUnifiedSchedulingEngine>
    <WakeToRun>false</WakeToRun>
    <ExecutionTimeLimit>PT0S</ExecutionTimeLimit>
    <Priority>4</Priority>
  </Settings>
  <Actions Context="Author">
    <Exec>
      <Command>${safeExe}</Command>
    </Exec>
  </Actions>
</Task>`
}

/** Delete pre-rebrand scheduled tasks (best effort, names may not exist). */
async function removeLegacyTasks(): Promise<void> {
  for (const name of LEGACY_TASK_NAMES) {
    await runSchtasks(['/Delete', '/F', '/TN', name])
  }
}

function devResult(action: string): AutoRunResult {
  // Dev runs must not leave a Task Scheduler entry pointing at electron.exe.
  return { ok: true, message: `Режим разработки: ${action} не регистрируется.` }
}

export async function enableAutoRun(): Promise<AutoRunResult> {
  if (is.dev) return devResult('автозапуск')
  if (process.platform !== 'win32') {
    return { ok: false, message: 'Автозапуск поддерживается только на Windows.' }
  }

  const exe = exePath()
  try {
    assertAutoRunTarget(exe)
  } catch (e) {
    return { ok: false, message: e instanceof Error ? e.message : String(e) }
  }

  // Migrate away from any legacy HKCU\Run entry and task.
  clearLegacyRunEntry()
  await removeLegacyTasks()

  const xml = buildTaskXml(exe, currentUserId())
  // schtasks reads the XML from a file path passed via /XML. Random name: a
  // fixed one in %TEMP% could be pre-created as a hardlink/symlink.
  const { writeFile, unlink } = await import('node:fs/promises')
  const { tmpdir } = await import('node:os')
  const { join } = await import('node:path')
  const xmlPath = join(tmpdir(), `skipnet-task-${randomUUID()}.xml`)
  // Task Scheduler expects UTF-16 LE with BOM for the XML file.
  const buf = Buffer.from('\ufeff' + xml, 'utf16le')
  try {
    await writeFile(xmlPath, buf, { flag: 'wx' })
    const r = await runSchtasks(['/Create', '/F', '/TN', TASK_NAME, '/XML', xmlPath])
    if (r.code !== 0) {
      return {
        ok: false,
        message:
          `Не удалось зарегистрировать автозапуск (schtasks код ${r.code}).` +
          (r.out.trim() ? ` ${r.out.trim()}` : '')
      }
    }
    return { ok: true, message: 'Автозапуск включён.' }
  } catch (e) {
    return {
      ok: false,
      message: `Не удалось зарегистрировать автозапуск: ${
        e instanceof Error ? e.message : String(e)
      }`
    }
  } finally {
    try { await unlink(xmlPath) } catch { /* noop */ }
  }
}

export async function disableAutoRun(): Promise<AutoRunResult> {
  if (is.dev) return devResult('отключение автозапуска')
  if (process.platform !== 'win32') {
    return { ok: false, message: 'Автозапуск поддерживается только на Windows.' }
  }
  clearLegacyRunEntry()
  await removeLegacyTasks()
  // /F forces silent removal even if task is missing or running.
  const r = await runSchtasks(['/Delete', '/F', '/TN', TASK_NAME])
  if (r.code === 0) return { ok: true, message: 'Автозапуск выключен.' }
  // A missing task is success: the desired end state is already true.
  const stillThere = await isAutoRun()
  if (!stillThere) return { ok: true, message: 'Автозапуск уже выключен.' }
  return {
    ok: false,
    message:
      `Не удалось удалить задачу автозапуска (schtasks код ${r.code}).` +
      (r.out.trim() ? ` ${r.out.trim()}` : '')
  }
}

export async function isAutoRun(): Promise<boolean> {
  if (is.dev) return false
  const r = await runSchtasks(['/Query', '/TN', TASK_NAME])
  return r.code === 0
}
