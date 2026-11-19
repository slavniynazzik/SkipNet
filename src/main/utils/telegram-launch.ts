/**
 * Telegram deep-link launch (T4 / B2 / R-09).
 *
 * Opening `tg://` from an elevated app must not elevate Telegram, and the link
 * contains the MTProto proxy secret, so it must never be written to a log or
 * left in a user-readable file.
 *
 * The link is handed to a **one-shot Task Scheduler task** created from an XML
 * definition (`schtasks /Create /XML`). The XML is staged in the admin-only
 * `%ProgramData%\SkipNet\tasks` directory, the task runs as the interactive
 * user with `LeastPrivilege`, starts `%SystemRoot%\explorer.exe` with the URL,
 * and is deleted in `finally` after a short linger.
 *
 * Why XML and not `/TR`: the previous implementation packed a PowerShell
 * `-EncodedCommand` into `/TR`, and the base64 payload of a real proxy URL is
 * far longer than the 262-character `/TR` limit. `schtasks` either truncated it
 * or refused the task. The XML action carries the URL as a plain `<Arguments>`
 * value, so there is no command-line length limit and no PowerShell layer.
 *
 * If Task Scheduler refuses the task (policy, disabled service, a locked-down
 * image), the fallback is `explorer.exe <url>`. Explorer is the shell's
 * de-elevation bridge: the running shell opens the URL at medium integrity, so
 * Telegram does not inherit SkipNet's elevated token. `shell.openExternal`
 * was wrong here — called from a high-IL process it opens the handler at high
 * IL.
 */

import { execFile, spawn } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { existsSync, unlinkSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { promisify } from 'node:util'
import { redactSecrets } from './redact'
import { secureStagingDir } from './secure-staging'
import { sysBin } from './sys-bin'

const execFileAsync = promisify(execFile)

export const TELEGRAM_URL_MAX_LENGTH = 4096
const CONTROL_CHARS = /[\u0000-\u001F\u007F]/ // eslint-disable-line no-control-regex
/** De-duplicates double clicks and button spam; kept from the old handler. */
export const TG_INFLIGHT_LOCK_MS = 600
/**
 * Task Scheduler needs the task to stay registered while `/Run` settles.
 * Deleting it in the same tick as `/Run` raced the scheduler and either failed
 * with "task is currently running" or removed the task before it started.
 */
export const TELEGRAM_TASK_LINGER_MS = 5000
const TELEGRAM_TASK_DESCRIPTION = 'SkipNet one-shot Telegram deep link'

let tgInflightUntil = 0

/** Reset the in-memory spam lock (unit suite seam). */
export function resetTelegramLaunchLockForTesting(): void {
  tgInflightUntil = 0
}

/**
 * Only `tg:` links and Telegram's own https hosts may be launched. Applied
 * before rendering the XML, so a crafted string can never reach a command line.
 */
export function isAllowedTelegramUrl(url: string): boolean {
  if (typeof url !== 'string') return false
  if (url.length === 0 || url.length > TELEGRAM_URL_MAX_LENGTH) return false
  if (CONTROL_CHARS.test(url)) return false
  try {
    const parsed = new URL(url)
    if (parsed.protocol === 'tg:') return true
    return (
      parsed.protocol === 'https:' &&
      (parsed.hostname === 't.me' || parsed.hostname === 'telegram.me')
    )
  } catch {
    return false
  }
}

/** Escape a value for an XML text node or a double-quoted attribute. */
export function escapeXml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;')
}

export function buildTelegramTaskName(now: number = Date.now()): string {
  return `SkipNet_OpenTG_${now}_${randomUUID().replace(/-/g, '').slice(0, 8)}`
}

export interface TelegramLaunchTask {
  taskName: string
  /** UTF-16 task definition for `schtasks /Create /XML`. */
  xml: string
}

/**
 * The task definition.
 *
 * - `InteractiveToken` + `LeastPrivilege`: run as the signed-in user with the
 *   filtered token, exactly what a normal double-click of a `tg://` link gets.
 * - `%SystemRoot%\explorer.exe` as the command: Task Scheduler expands the
 *   environment variable and Explorer delegates the URL to the existing shell.
 * - No triggers: the task exists only between `/Run` and `/Delete`.
 */
export function buildTelegramTaskXml(url: string, taskName: string): string {
  if (!isAllowedTelegramUrl(url)) {
    throw new Error('unsupported Telegram link')
  }
  const safeName = escapeXml(taskName)
  const safeUrl = escapeXml(`"${url}"`)
  return [
    '<?xml version="1.0" encoding="UTF-16"?>',
    '<Task version="1.2" xmlns="http://schemas.microsoft.com/windows/2004/02/mit/task">',
    '  <RegistrationInfo>',
    `    <Description>${TELEGRAM_TASK_DESCRIPTION}</Description>`,
    `    <URI>\\${safeName}</URI>`,
    '  </RegistrationInfo>',
    '  <Triggers />',
    '  <Principals>',
    '    <Principal id="Author">',
    '      <LogonType>InteractiveToken</LogonType>',
    '      <RunLevel>LeastPrivilege</RunLevel>',
    '    </Principal>',
    '  </Principals>',
    '  <Settings>',
    '    <MultipleInstancesPolicy>IgnoreNew</MultipleInstancesPolicy>',
    '    <DisallowStartIfOnBatteries>false</DisallowStartIfOnBatteries>',
    '    <StopIfGoingOnBatteries>false</StopIfGoingOnBatteries>',
    '    <AllowHardTerminate>true</AllowHardTerminate>',
    '    <StartWhenAvailable>false</StartWhenAvailable>',
    '    <RunOnlyIfNetworkAvailable>false</RunOnlyIfNetworkAvailable>',
    '    <IdleSettings>',
    '      <StopOnIdleEnd>false</StopOnIdleEnd>',
    '      <RestartOnIdle>false</RestartOnIdle>',
    '    </IdleSettings>',
    '    <AllowStartOnDemand>true</AllowStartOnDemand>',
    '    <Enabled>true</Enabled>',
    '    <Hidden>false</Hidden>',
    '    <RunOnlyIfIdle>false</RunOnlyIfIdle>',
    '    <WakeToRun>false</WakeToRun>',
    '    <ExecutionTimeLimit>PT5M</ExecutionTimeLimit>',
    '    <Priority>7</Priority>',
    '  </Settings>',
    '  <Actions Context="Author">',
    '    <Exec>',
    '      <Command>%SystemRoot%\\explorer.exe</Command>',
    `      <Arguments>${safeUrl}</Arguments>`,
    '    </Exec>',
    '  </Actions>',
    '</Task>',
    ''
  ].join('\r\n')
}

/**
 * Build the one-shot task. Throws (without echoing the URL) when the link is
 * not an allowed Telegram URL.
 */
export function buildTelegramLaunchTask(
  url: string,
  taskName?: string
): TelegramLaunchTask {
  if (!isAllowedTelegramUrl(url)) {
    throw new Error('unsupported Telegram link')
  }
  const name = taskName?.trim() || buildTelegramTaskName()
  return { taskName: name, xml: buildTelegramTaskXml(url, name) }
}

export function buildTelegramCreateArgs(taskName: string, xmlPath: string): string[] {
  return ['/Create', '/F', '/TN', taskName, '/XML', xmlPath]
}

export function buildTelegramRunArgs(taskName: string): string[] {
  return ['/Run', '/TN', taskName]
}

export function buildTelegramDeleteArgs(taskName: string): string[] {
  return ['/Delete', '/F', '/TN', taskName]
}

export interface TelegramFallbackCommand {
  file: string
  args: string[]
}

/** De-elevated fallback: the shell opens the link at medium integrity. */
export function buildTelegramFallback(url: string): TelegramFallbackCommand {
  return { file: sysBin('explorer.exe'), args: [url] }
}

interface ExecErrorLike {
  code?: unknown
  name?: unknown
  stderr?: unknown
}

/**
 * Format a launch failure for the log without ever printing the URL or the
 * child-process `.message` (which can quote the full command line).
 */
export function describeTelegramError(stage: string, err: unknown, url?: string): string {
  const record = (err ?? {}) as ExecErrorLike
  const code =
    typeof record.code === 'string' || typeof record.code === 'number'
      ? String(record.code)
      : ''
  const name = typeof record.name === 'string' ? record.name : ''
  const stderr = typeof record.stderr === 'string' ? record.stderr.trim() : ''
  const details: string[] = []
  if (code) details.push(`code=${code}`)
  if (name) details.push(`name=${name}`)
  if (stderr) {
    const extra = url && url.length >= 8 ? [url] : undefined
    details.push(`stderr=${redactSecrets(stderr, extra)}`)
  }
  return `[openTelegramLink] ${stage}${details.length > 0 ? `: ${details.join(' ')}` : ''}`
}

export interface TelegramLaunchHooks {
  /** Test seam; defaults to `process.platform`. */
  platform?: NodeJS.Platform
  /** Runs `schtasks.exe`; resolves on exit code 0, rejects otherwise. */
  exec?: (file: string, args: string[], timeoutMs: number) => Promise<void>
  /** Starts the fallback handler; defaults to detached `spawn`. */
  spawnFallback?: (file: string, args: string[]) => void
  sleep?: (ms: number) => Promise<void>
  stagingDir?: () => string
  writeStaged?: (file: string, data: Buffer) => void
  removeStaged?: (file: string) => void
  log?: (line: string) => void
  now?: () => number
}

async function defaultExec(file: string, args: string[], timeoutMs: number): Promise<void> {
  await execFileAsync(file, args, { windowsHide: true, timeout: timeoutMs })
}

function defaultSpawn(file: string, args: string[]): void {
  const child = spawn(file, args, {
    detached: true,
    stdio: 'ignore',
    windowsHide: true
  })
  child.on('error', () => undefined)
  child.unref()
}

function defaultRemove(file: string): void {
  try {
    if (existsSync(file)) unlinkSync(file)
  } catch {
    /* staging directory is cleaned on the next launch */
  }
}

function writeUtf16Xml(file: string, xml: Buffer): void {
  // `schtasks /XML` requires a Unicode file. UTF-16LE with a BOM is accepted on
  // every supported Windows; `wx` refuses to follow a pre-created link.
  const data = Buffer.concat([Buffer.from([0xff, 0xfe]), xml])
  writeFileSync(file, data, { flag: 'wx', mode: 0o600 })
}

function runFallback(
  url: string,
  hooks: TelegramLaunchHooks,
  log: (line: string) => void
): void {
  const command = buildTelegramFallback(url)
  try {
    if (hooks.spawnFallback) hooks.spawnFallback(command.file, command.args)
    else defaultSpawn(command.file, command.args)
  } catch (e) {
    log(describeTelegramError('explorer fallback', e, url))
  }
}

/**
 * Open a Telegram link. Never rejects: a failed scheduler run falls back to
 * `explorer.exe`, and both paths are rate-limited by the inflight lock.
 */
export async function openTelegramLink(
  url: string,
  hooks: TelegramLaunchHooks = {}
): Promise<void> {
  const log = hooks.log ?? ((line: string) => console.error(line))

  if (!isAllowedTelegramUrl(url)) {
    log(describeTelegramError('rejected url', { name: 'unsupported scheme/host' }))
    return
  }

  const nowMs = (hooks.now ?? Date.now)()
  if (nowMs < tgInflightUntil) return
  tgInflightUntil = nowMs + TG_INFLIGHT_LOCK_MS

  const platform = hooks.platform ?? process.platform
  if (platform !== 'win32') {
    runFallback(url, hooks, log)
    return
  }

  let task: TelegramLaunchTask
  try {
    task = buildTelegramLaunchTask(url)
  } catch (e) {
    log(describeTelegramError('build task', e, url))
    runFallback(url, hooks, log)
    return
  }

  const exec = hooks.exec ?? defaultExec
  const sleep =
    hooks.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)))
  const stageDir =
    hooks.stagingDir ?? (() => secureStagingDir('tasks'))
  const writeStaged = hooks.writeStaged ?? writeUtf16Xml
  const removeStaged = hooks.removeStaged ?? defaultRemove
  const schtasks = sysBin('schtasks.exe')

  let xmlPath: string | null = null
  let created = false
  let failure: unknown = null

  try {
    xmlPath = path.join(stageDir(), `telegram-${randomUUID()}.xml`)
    writeStaged(xmlPath, Buffer.from(task.xml, 'utf16le'))
    await exec(schtasks, buildTelegramCreateArgs(task.taskName, xmlPath), 15_000)
    created = true
    await exec(schtasks, buildTelegramRunArgs(task.taskName), 10_000)
    // Keep the task alive until the scheduler has actually started it.
    await sleep(TELEGRAM_TASK_LINGER_MS)
  } catch (e) {
    failure = e
  } finally {
    if (created) {
      try {
        await exec(schtasks, buildTelegramDeleteArgs(task.taskName), 10_000)
      } catch {
        /* already deleted / the scheduler removed it with the run */
      }
    }
    if (xmlPath) removeStaged(xmlPath)
  }

  if (failure) {
    log(describeTelegramError('schtasks', failure, url))
    runFallback(url, hooks, log)
  }
}
