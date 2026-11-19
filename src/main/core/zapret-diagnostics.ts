/**
 * Diagnostics, tests and maintenance actions ported from Flowseal's
 * `service.bat`:
 *
 *  - "Run Diagnostics" — BFE, proxy, TCP timestamps, conflicting security /
 *    network products, path issues, WinDivert state, VPN, DNS, hosts file;
 *  - "Run Tests" — launches the bundle's `utils/test zapret.ps1`;
 *  - "Auto-Update Check" — toggles `utils/check_updates.enabled`;
 *  - Discord cache cleanup.
 */

import { existsSync, mkdirSync, rmSync, unlinkSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { spawn, spawnSync } from 'node:child_process'
import { zapretBundleDir } from '../utils/dirs'
import { runPowerShellElevated } from '../utils/elevated'
import { sysBin } from '../utils/sys-bin'
import { getFailedShortcuts } from '../resolve/shortcut-status'
import { hostsHasYoutubeEntries } from './zapret-hosts'
import { verifyZapretBundle } from './binary-integrity'

export type DiagStatus = 'ok' | 'warn' | 'fail' | 'info'

export type DiagFixId =
  | 'tcpTimestamps'
  | 'windivert'
  | 'conflictingBypasses'
  | 'discordCache'

export interface DiagCheck {
  id: string
  title: string
  status: DiagStatus
  detail?: string
  hint?: string
  fix?: DiagFixId
}

export interface DiagnosticsReport {
  generatedAt: number
  checks: DiagCheck[]
}

function run(command: string, args: string[], timeout = 6000): string {
  try {
    const r = spawnSync(command, args, {
      windowsHide: true,
      timeout,
      encoding: 'utf8'
    })
    return `${r.stdout ?? ''}\n${r.stderr ?? ''}`
  } catch {
    return ''
  }
}

function scList(): string {
  return run(sysBin('sc.exe'), ['query'], 8000)
}

function serviceExists(name: string): boolean {
  const r = spawnSync(sysBin('sc.exe'), ['query', name], { windowsHide: true, timeout: 3000, encoding: 'utf8' })
  return r.status === 0
}

/**
 * Is a Windows service running? Exported so the Zapret preflight can fail fast
 * on a stopped BFE instead of waiting out the 7-second winws health window (S3).
 */
export function isWindowsServiceRunning(name: string): boolean {
  return serviceRunning(name)
}

function serviceRunning(name: string): boolean {
  const out = run(sysBin('sc.exe'), ['query', name], 4000)
  // `sc.exe` localises the field label (STATE / СОСТОЯНИЕ / …), but keeps the
  // numeric state and the RUNNING token in English. Match the value only,
  // otherwise every service looks stopped on non-English Windows.
  return /:\s*\d+\s+RUNNING\b/i.test(out)
}

function isWinwsRunning(): boolean {
  const out = run(sysBin('tasklist.exe'), ['/FI', 'IMAGENAME eq winws.exe', '/NH'], 5000)
  return /winws\.exe/i.test(out)
}

function processRunning(image: string): boolean {
  const out = run(sysBin('tasklist.exe'), ['/FI', `IMAGENAME eq ${image}`, '/NH'], 5000)
  return new RegExp(image.replace(/\./g, '\\.'), 'i').test(out)
}

function tcpTimestampsEnabled(): boolean | null {
  const out = run(sysBin('netsh.exe'), ['interface', 'tcp', 'show', 'global'], 5000)
  // Field names are localised: "RFC 1323 Timestamps" on English Windows,
  // "Метки времени RFC 1323" on Russian, etc. The value stays English.
  const line = out
    .split(/\r?\n/)
    .find((l) => /RFC\s*1323|timestamps|Метки времени/i.test(l))
  if (!line) return null
  if (/:\s*enabled\b/i.test(line)) return true
  if (/:\s*disabled\b/i.test(line)) return false
  return null
}

function proxyEnabled(): { enabled: boolean; server: string } {
  const out = run(sysBin('reg.exe'), [
    'query',
    'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Internet Settings',
    '/v',
    'ProxyEnable'
  ])
  const m = /ProxyEnable\s+REG_DWORD\s+(0x[0-9a-f]+|\d+)/i.exec(out)
  const value = m ? Number(m[1]) : 0
  let server = ''
  if (value === 1) {
    const s = run(sysBin('reg.exe'), [
      'query',
      'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Internet Settings',
      '/v',
      'ProxyServer'
    ])
    const sm = /ProxyServer\s+REG_SZ\s+(.+)$/im.exec(s)
    server = sm?.[1]?.trim() ?? ''
  }
  return { enabled: value === 1, server }
}

function dohConfigured(): boolean {
  const out = run(sysBin('reg.exe'), [
    'query',
    'HKLM\\SYSTEM\\CurrentControlSet\\Services\\Dnscache\\InterfaceSpecificParameters',
    '/s',
    '/v',
    'DohFlags'
  ], 8000)
  return out
    .split(/\r?\n/)
    .some((line) => /DohFlags\s+REG_DWORD\s+0x(?:0*[1-9a-f][0-9a-f]*)/i.test(line))
}

const CONFLICTING_BYPASSES = ['GoodbyeDPI', 'discordfix_zapret', 'winws1', 'winws2']
const WINDIVERT_NAMES = ['WinDivert', 'WinDivert14']

function listRunningServices(): string[] {
  const out = scList()
  const names: string[] = []

  // `sc query` prints one block per service, separated by blank lines. The
  // first line of a block is the service name, the second is the localised
  // display name — both start at column 0, so matching every `label: value`
  // line would treat display names as service names and produce false
  // conflicts (e.g. a display name that merely contains "Killer").
  const flush = (block: string[]): void => {
    const first = block.find((line) => line.trim() !== '')
    if (!first) return
    const match = /^([^\s:][^:]*):\s*(\S+)\s*$/.exec(first)
    if (match) names.push(match[2])
  }

  let block: string[] = []
  for (const line of out.split(/\r?\n/)) {
    if (line.trim() === '') {
      flush(block)
      block = []
    } else {
      block.push(line)
    }
  }
  flush(block)
  return names
}

/** Run every check from `service.bat`'s "Run Diagnostics" menu item. */
export function runZapretDiagnostics(): DiagnosticsReport {
  const bundle = zapretBundleDir()
  const checks: DiagCheck[] = []
  const services = listRunningServices()
  const serviceText = services.join('\n')

  checks.push({
    id: 'bundle',
    title: 'Расположение Zapret',
    status: 'info',
    detail: bundle
  })

  checks.push(
    serviceRunning('BFE')
      ? { id: 'bfe', title: 'Base Filtering Engine', status: 'ok' }
      : {
          id: 'bfe',
          title: 'Base Filtering Engine',
          status: 'fail',
          detail: 'Служба BFE не запущена.',
          hint: 'Она необходима для работы Zapret. Запустите службу и повторите проверку.'
        }
  )

  const proxy = proxyEnabled()
  checks.push(
    proxy.enabled
      ? {
          id: 'proxy',
          title: 'Системный прокси',
          status: 'warn',
          detail: proxy.server ? `Включён прокси: ${proxy.server}` : 'Системный прокси включён.',
          hint: 'Убедитесь, что прокси рабочий, или отключите его, если не используете.'
        }
      : { id: 'proxy', title: 'Системный прокси', status: 'ok' }
  )

  const timestamps = tcpTimestampsEnabled()
  checks.push(
    timestamps === true
      ? { id: 'tcpTimestamps', title: 'TCP timestamps', status: 'ok' }
      : timestamps === false
        ? {
            id: 'tcpTimestamps',
            title: 'TCP timestamps',
            status: 'warn',
            detail: 'TCP timestamps отключены.',
            hint: 'Нажмите «Исправить», чтобы включить их.',
            fix: 'tcpTimestamps'
          }
        : {
            id: 'tcpTimestamps',
            title: 'TCP timestamps',
            status: 'info',
            detail: 'Не удалось определить состояние TCP timestamps.',
            hint: 'Проверьте вручную: netsh interface tcp show global'
          }
  )

  checks.push(
    processRunning('AdguardSvc.exe')
      ? {
          id: 'adguard',
          title: 'Adguard',
          status: 'fail',
          detail: 'Найден процесс AdguardSvc.exe.',
          hint: 'Adguard может мешать работе Discord и Zapret.'
        }
      : { id: 'adguard', title: 'Adguard', status: 'ok' }
  )

  checks.push(
    /Killer/i.test(serviceText)
      ? {
          id: 'killer',
          title: 'Killer',
          status: 'fail',
          detail: 'Найдены службы Killer.',
          hint: 'Killer конфликтует с Zapret — отключите или удалите его.'
        }
      : { id: 'killer', title: 'Killer', status: 'ok' }
  )

  checks.push(
    services.some((n) => /Intel/i.test(n) && /Connectivity/i.test(n) && /Network/i.test(n))
      ? {
          id: 'intel',
          title: 'Intel Connectivity Network',
          status: 'fail',
          detail: 'Найдена служба Intel Connectivity Network.',
          hint: 'Она конфликтует с Zapret.'
        }
      : { id: 'intel', title: 'Intel Connectivity Network', status: 'ok' }
  )

  checks.push(
    services.some((n) => /TracSrvWrapper|EPWD/i.test(n))
      ? {
          id: 'checkpoint',
          title: 'Check Point',
          status: 'fail',
          detail: 'Найдены службы Check Point.',
          hint: 'Check Point конфликтует с Zapret — попробуйте удалить его.'
        }
      : { id: 'checkpoint', title: 'Check Point', status: 'ok' }
  )

  checks.push(
    /SmartByte/i.test(serviceText)
      ? {
          id: 'smartbyte',
          title: 'SmartByte',
          status: 'fail',
          detail: 'Найдены службы SmartByte.',
          hint: 'Отключите или удалите SmartByte через services.msc.'
        }
      : { id: 'smartbyte', title: 'SmartByte', status: 'ok' }
  )

  checks.push(
    /[А-Яа-яЁё]/.test(bundle)
      ? {
          id: 'cyrillicPath',
          title: 'Кириллица в пути',
          status: 'warn',
          detail: bundle,
          hint: 'Если обход не работает, перенесите Zapret в путь без кириллицы, например C:\\zapret.'
        }
      : { id: 'cyrillicPath', title: 'Кириллица в пути', status: 'ok' }
  )

  const oneDrive = process.env.OneDrive
  checks.push(
    !!oneDrive && bundle.toLowerCase().startsWith(`${oneDrive.toLowerCase()}\\`)
      ? {
          id: 'onedrive',
          title: 'OneDrive',
          status: 'fail',
          detail: 'Zapret находится в папке OneDrive.',
          hint: 'Перенесите его в другую папку, например C:\\zapret.'
        }
      : { id: 'onedrive', title: 'OneDrive', status: 'ok' }
  )

  const sysFiles = ['WinDivert64.sys', 'WinDivert.sys']
  const hasSys = sysFiles.some((f) => existsSync(path.join(bundle, 'bin', f)))
  checks.push(
    hasSys
      ? { id: 'windivertSys', title: 'Драйвер WinDivert', status: 'ok' }
      : {
          id: 'windivertSys',
          title: 'Драйвер WinDivert',
          status: 'fail',
          detail: 'Файл WinDivert64.sys не найден в bin.',
          hint: 'Переустановите Zapret-бандл.'
        }
  )

  const vpnServices = services.filter((n) => /VPN|HappService/i.test(n))
  checks.push(
    vpnServices.length > 0
      ? {
          id: 'vpn',
          title: 'VPN',
          status: 'warn',
          detail: `Найдены службы: ${vpnServices.join(', ')}`,
          hint: 'Некоторые VPN конфликтуют с Zapret — отключите их на время проверки.'
        }
      : { id: 'vpn', title: 'VPN', status: 'ok' }
  )

  checks.push(
    dohConfigured()
      ? { id: 'dns', title: 'Secure DNS', status: 'ok' }
      : {
          id: 'dns',
          title: 'Secure DNS',
          status: 'warn',
          detail: 'В Windows не настроен шифрованный DNS.',
          hint: 'Настройте защищённый DNS в браузере или в параметрах Windows 11.'
        }
  )

  checks.push(
    hostsHasYoutubeEntries()
      ? {
          id: 'hostsYoutube',
          title: 'Hosts и YouTube',
          status: 'warn',
          detail: 'В hosts есть записи youtube.com или youtu.be.',
          hint: 'Это может мешать доступу к YouTube — удалите эти записи.'
        }
      : { id: 'hostsYoutube', title: 'Hosts и YouTube', status: 'ok' }
  )

  const winwsRunning = isWinwsRunning()
  const windivertActive = WINDIVERT_NAMES.some((n) => serviceRunning(n))
  checks.push(
    !winwsRunning && windivertActive
      ? {
          id: 'windivertConflict',
          title: 'WinDivert',
          status: 'warn',
          detail: 'winws.exe не запущен, но служба WinDivert активна.',
          hint: 'Нажмите «Исправить», чтобы остановить и удалить зависшую службу.',
          fix: 'windivert'
        }
      : { id: 'windivertConflict', title: 'WinDivert', status: 'ok' }
  )

  const bypasses = CONFLICTING_BYPASSES.filter((n) => serviceExists(n))
  checks.push(
    bypasses.length > 0
      ? {
          id: 'bypasses',
          title: 'Другие обходы',
          status: 'warn',
          detail: `Найдены службы: ${bypasses.join(', ')}`,
          hint: 'Нажмите «Исправить», чтобы остановить и удалить их.',
          fix: 'conflictingBypasses'
        }
      : { id: 'bypasses', title: 'Другие обходы', status: 'ok' }
  )

  const failedShortcuts = getFailedShortcuts()
  checks.push(
    failedShortcuts.length > 0
      ? {
          id: 'shortcuts',
          title: 'Глобальные горячие клавиши',
          status: 'warn',
          detail: `Не удалось зарегистрировать: ${failedShortcuts.join(', ')}`,
          hint: 'Комбинацию уже использует другое приложение. Выберите другую в настройках.'
        }
      : { id: 'shortcuts', title: 'Глобальные горячие клавиши', status: 'ok' }
  )

  return { generatedAt: Date.now(), checks }
}

export interface DiagnosticsFixResult {
  ok: boolean
  message: string
}

export function fixTcpTimestamps(): DiagnosticsFixResult {
  const applyDirect = (): boolean => {
    const r = spawnSync(sysBin('netsh.exe'), ['interface', 'tcp', 'set', 'global', 'timestamps=enabled'], {
      windowsHide: true,
      timeout: 10_000,
      encoding: 'utf8'
    })
    return r.status === 0
  }

  let applied = applyDirect()

  // Fallback for a non-elevated session (portable launch, UAC-stripped
  // wrapper): ask Windows for elevation through the standard UAC prompt.
  if (!applied) {
    const elevated = runPowerShellElevated(
      "netsh.exe interface tcp set global timestamps=enabled | Out-Null\r\n" +
        "if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }",
      30_000
    )
    applied = elevated.ok
  }

  const state = tcpTimestampsEnabled()
  if (state === true) {
    return { ok: true, message: 'TCP timestamps включены.' }
  }
  if (applied && state === null) {
    // The command succeeded but this Windows locale is unknown to us. Don't
    // claim a failure we cannot verify.
    return {
      ok: true,
      message: 'Команда включения TCP timestamps выполнена. Перезапустите проверку при необходимости.'
    }
  }
  return {
    ok: false,
    message:
      'Не удалось включить TCP timestamps. Запустите SkipNet от администратора и повторите попытку.'
  }
}

export function fixWindivertConflict(): DiagnosticsFixResult {
  // Deleting the WinDivert service while our own winws.exe is capturing drops
  // the driver under the active session and silently breaks bypassing until
  // Zapret is restarted. The check only offers this fix when winws is down,
  // but the handler is reachable directly, so guard here as well.
  if (isWinwsRunning()) {
    return {
      ok: false,
      message: 'Zapret уже запущен и использует WinDivert. Сначала остановите Zapret.'
    }
  }
  const messages: string[] = []
  for (const name of WINDIVERT_NAMES) {
    if (!serviceExists(name)) continue
    run(sysBin('sc.exe'), ['stop', name], 6000)
    run(sysBin('sc.exe'), ['delete', name], 6000)
    messages.push(name)
  }
  if (messages.length === 0) {
    return { ok: true, message: 'Зависшая служба WinDivert не найдена.' }
  }
  return { ok: true, message: `Удалены службы: ${messages.join(', ')}.` }
}

export function removeConflictingBypasses(): DiagnosticsFixResult {
  const removed: string[] = []
  for (const name of CONFLICTING_BYPASSES) {
    if (!serviceExists(name)) continue
    run(sysBin('sc.exe'), ['stop', name], 6000)
    run(sysBin('sc.exe'), ['delete', name], 6000)
    removed.push(name)
  }
  // Only clean up WinDivert when our own bypass is not using it. Deleting the
  // service while winws.exe runs drops the driver the active session depends
  // on and silently breaks bypassing until Zapret is restarted.
  if (!isWinwsRunning()) {
    for (const name of WINDIVERT_NAMES) {
      if (!serviceExists(name)) continue
      run(sysBin('sc.exe'), ['stop', name], 6000)
      run(sysBin('sc.exe'), ['delete', name], 6000)
    }
  }
  return removed.length
    ? { ok: true, message: `Удалены службы: ${removed.join(', ')}.` }
    : { ok: true, message: 'Конфликтующие службы не найдены.' }
}

// ---- Auto-update check toggle --------------------------------------------

export function autoUpdateCheckFile(): string {
  return path.join(zapretBundleDir(), 'utils', 'check_updates.enabled')
}

export function getAutoUpdateCheck(): boolean {
  return existsSync(autoUpdateCheckFile())
}

export function setAutoUpdateCheck(enabled: boolean): boolean {
  const file = autoUpdateCheckFile()
  try {
    if (enabled) {
      // `utils/` is normally shipped, but older installs might be missing it
      // (it used to be excluded from the installer). Create it on demand so
      // toggling the setting never fails with ENOENT.
      mkdirSync(path.dirname(file), { recursive: true })
      writeFileSync(file, 'ENABLED\r\n', 'ascii')
    } else if (existsSync(file)) {
      unlinkSync(file)
    }
  } catch (e) {
    throw new Error(
      `Не удалось изменить check_updates.enabled: ${e instanceof Error ? e.message : String(e)}`
    )
  }
  return existsSync(file)
}

// ---- Run tests ------------------------------------------------------------

export interface RunTestsResult {
  started: boolean
  script: string
  message: string
}

/** Launch the bundle's own PowerShell test suite in a visible console. */
export function runZapretTests(): RunTestsResult {
  const script = path.join(zapretBundleDir(), 'utils', 'test zapret.ps1')
  if (!existsSync(script)) {
    return { started: false, script, message: 'Файл utils\\test zapret.ps1 не найден в бандле.' }
  }
  // The script lives in the executable payload: verify the whole bundle (and
  // this file in particular) before handing it to PowerShell.
  try {
    verifyZapretBundle(zapretBundleDir())
  } catch (e) {
    return {
      started: false,
      script,
      message: e instanceof Error ? e.message : String(e)
    }
  }
  try {
    const p = spawn(
      sysBin('powershell.exe'),
      ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', script],
      { detached: true, stdio: 'ignore', windowsHide: false }
    )
    p.unref()
    return { started: true, script, message: 'Тесты запущены в отдельном окне PowerShell.' }
  } catch (e) {
    return {
      started: false,
      script,
      message: `Не удалось запустить тесты: ${e instanceof Error ? e.message : String(e)}`
    }
  }
}

// ---- Discord cache cleanup ------------------------------------------------

export interface DiscordCacheResult {
  closed: string[]
  cleared: string[]
  failed: string[]
  found: boolean
}

/** Close Discord and delete its Cache / Code Cache / GPUCache folders. */
export function clearDiscordCache(): DiscordCacheResult {
  const appData = process.env.APPDATA
  const variants = [
    { exe: 'Discord.exe', dir: 'discord' },
    { exe: 'DiscordPTB.exe', dir: 'discordptb' },
    { exe: 'DiscordCanary.exe', dir: 'discordcanary' },
    { exe: 'DiscordDevelopment.exe', dir: 'discorddevelopment' }
  ]
  const result: DiscordCacheResult = { closed: [], cleared: [], failed: [], found: false }
  if (!appData) return result

  for (const v of variants) {
    const root = path.join(appData, v.dir)
    if (!existsSync(root)) continue
    result.found = true
    if (processRunning(v.exe)) {
      run(sysBin('taskkill.exe'), ['/IM', v.exe, '/F'], 8000)
      result.closed.push(v.exe)
    }
    for (const sub of ['Cache', 'Code Cache', 'GPUCache']) {
      const dir = path.join(root, sub)
      if (!existsSync(dir)) continue
      try {
        rmSync(dir, { recursive: true, force: true })
        result.cleared.push(path.join(v.dir, sub))
      } catch {
        result.failed.push(path.join(v.dir, sub))
      }
    }
  }
  return result
}
