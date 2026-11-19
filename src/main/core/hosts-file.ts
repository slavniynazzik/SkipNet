/**
 * Low-level access to the Windows hosts file.
 *
 * Shared by the hosts editor, diagnostics and backups. The file is handled as
 * latin1 so arbitrary legacy bytes survive a read → edit → write round-trip:
 * hostnames and IPs are ASCII, and unrelated comment bytes are never
 * re-encoded.
 */

import {
  accessSync,
  closeSync,
  constants,
  existsSync,
  fsyncSync,
  openSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeFileSync,
  writeSync
} from 'node:fs'
import { createHash, randomUUID } from 'node:crypto'
import os from 'node:os'
import path from 'node:path'
import { execFile } from 'node:child_process'
import { psQuote, runPowerShellElevated } from '../utils/elevated'

const BLOCK_START = '# --- SkipNet hosts editor BEGIN ---'
const BLOCK_END = '# --- SkipNet hosts editor END ---'

function windowsRoot(): string {
  const raw = (process.env.SystemRoot || process.env.windir || 'C:\\Windows').replace(
    /[\\/]+$/,
    ''
  )
  // Do not let an inherited environment variable redirect a privileged write
  // to an arbitrary directory.
  return /^[a-z]:\\(?:Windows|WINNT)$/i.test(raw) ? raw : 'C:\\Windows'
}

/**
 * Test seam: the unit suite must never read or write the real system hosts
 * file. Deliberately not backed by an environment variable or the config —
 * nothing the renderer can influence may redirect a privileged write.
 */
let hostsPathOverride: string | null = null

export function setHostsPathForTesting(target: string | null): void {
  hostsPathOverride = target
}

export function windowsHostsPath(): string {
  return hostsPathOverride ?? path.join(windowsRoot(), 'System32', 'drivers', 'etc', 'hosts')
}

/** Read the hosts file byte-for-byte (latin1 round-trips arbitrary bytes). */
export function readHostsRaw(): string {
  try {
    return readFileSync(windowsHostsPath()).toString('latin1')
  } catch {
    return ''
  }
}

/**
 * Strict variant for mutations: a missing file is treated as empty, but an
 * existing unreadable file must abort the write. Otherwise a transient AV lock
 * would look like an empty file and the next save would delete every entry.
 */
export function readHostsRawStrict(): string {
  const target = windowsHostsPath()
  if (!existsSync(target)) return ''
  return readFileSync(target).toString('latin1')
}

export interface LenientHostsRead {
  /** Bytes of the file, or `''` when the file is missing or unreadable. */
  content: string
  /** False only when an existing file could not be read (EPERM/EBUSY/…). */
  ok: boolean
  error?: string
}

/**
 * Lenient variant for read-only paths (page loads, overview snapshots).
 *
 * A transient AV/indexer lock must render the saved state with a warning, not
 * break the whole page. Mutations still use `readHostsRawStrict` so a lock can
 * never be mistaken for an empty file and delete every entry.
 */
export function readHostsRawLenient(): LenientHostsRead {
  const target = windowsHostsPath()
  try {
    if (!existsSync(target)) return { content: '', ok: true }
    return { content: readFileSync(target).toString('latin1'), ok: true }
  } catch (e) {
    const code = (e as NodeJS.ErrnoException)?.code
    if (code === 'ENOENT') return { content: '', ok: true }
    return {
      content: '',
      ok: false,
      error: e instanceof Error ? e.message : String(e)
    }
  }
}

/** Read the hosts file as UTF-8 for display/diagnostics. */
export function readHostsText(): string {
  try {
    return readFileSync(windowsHostsPath(), 'utf-8')
  } catch {
    return ''
  }
}

export function hostsFileExists(): boolean {
  return existsSync(windowsHostsPath())
}

/** Best-effort write-access probe (the real check is the write attempt). */
export function hostsFileWritable(): boolean {
  const target = windowsHostsPath()
  try {
    if (existsSync(target)) accessSync(target, constants.W_OK)
    else accessSync(path.dirname(target), constants.W_OK)
    return true
  } catch {
    return false
  }
}

export type HostsWriteFailureReason = 'uac-cancelled' | 'elevated-failed' | 'direct-failed'

export interface HostsWriteResult {
  ok: boolean
  elevated: boolean
  reason?: HostsWriteFailureReason
  error?: string
}

const HOSTS_TEMP_PREFIX = 'hosts.skipnet-'

/**
 * Atomic in-place write: temp file **in the same directory** (a rename across
 * volumes is not atomic and would fail with EXDEV), `fsync` the bytes, then
 * `rename` over the target.
 *
 * If `rename` fails after the temp file was written — Windows returns EPERM or
 * EBUSY while Defender/indexer/backup holds a handle on `hosts` — we fall back
 * to the historical truncate-in-place write. Falling back is deliberate: the
 * caller has already decided that the *contents* must change, and failing here
 * would leave the user with a stale hosts file for a transient AV window. The
 * fallback is the only non-atomic path left, and it is documented as such.
 */
function writeHostsFileAtomically(target: string, payload: Buffer): void {
  const tmp = path.join(path.dirname(target), `${HOSTS_TEMP_PREFIX}${randomUUID()}.tmp`)
  let fd: number | null = null
  try {
    // `wx` refuses to follow a pre-created file/symlink in the privileged
    // etc directory (defence against a hardlink trick).
    fd = openSync(tmp, 'wx', 0o644)
    writeSync(fd, payload)
    fsyncSync(fd)
  } catch (e) {
    if (fd !== null) {
      try {
        closeSync(fd)
      } catch {
        /* noop */
      }
      fd = null
    }
    try {
      unlinkSync(tmp)
    } catch {
      /* noop */
    }
    throw e
  } finally {
    if (fd !== null) {
      try {
        closeSync(fd)
      } catch {
        /* noop */
      }
    }
  }

  try {
    renameSync(tmp, target)
  } catch (renameError) {
    try {
      writeFileSync(target, payload)
    } catch (writeError) {
      try {
        unlinkSync(tmp)
      } catch {
        /* noop */
      }
      // Prefer the truncate error: it is the one that explains why the caller
      // has to elevate. Keep the rename error attached for diagnostics.
      const detail = renameError instanceof Error ? renameError.message : String(renameError)
      if (writeError instanceof Error) {
        writeError.message = `${writeError.message} (rename: ${detail})`
      }
      throw writeError
    }
    try {
      unlinkSync(tmp)
    } catch {
      /* noop */
    }
  }
}

/**
 * Write the hosts file. Direct write works when SkipNet has administrator
 * rights; otherwise retry through a UAC-elevated PowerShell copy.
 *
 * The elevated result is classified, never inferred from "did the launcher
 * start": a dismissed UAC prompt and a failed elevated script both return
 * `ok: false` with a different `reason`.
 */
export function writeHostsContent(content: string): HostsWriteResult {
  return writeHostsContentTo(windowsHostsPath(), content)
}

/** Same writer with an explicit target, used by tests and future backups. */
export function writeHostsContentTo(target: string, content: string): HostsWriteResult {
  try {
    writeHostsFileAtomically(target, Buffer.from(content, 'latin1'))
    return { ok: true, elevated: false }
  } catch (directError) {
    const tempPath = path.join(os.tmpdir(), `skipnet-hosts-new-${randomUUID()}.txt`)
    try {
      const payload = Buffer.from(content, 'latin1')
      writeFileSync(tempPath, payload, { flag: 'wx' })
      const expected = createHash('sha256').update(payload).digest('hex')
      // The elevated copy verifies the bytes, so a process that swaps the
      // %TEMP% file while the UAC prompt is open cannot inject hosts entries.
      const script =
        `$expected = '${expected}'\r\n` +
        `$actual = (Get-FileHash -LiteralPath ${psQuote(tempPath)} -Algorithm SHA256).Hash.ToLower()\r\n` +
        "if ($actual -ne $expected) { Write-Error 'hosts checksum mismatch'; exit 1 }\r\n" +
        'try {\r\n' +
        `  Copy-Item -LiteralPath ${psQuote(tempPath)} -Destination ${psQuote(target)} -Force -ErrorAction Stop\r\n` +
        '} catch {\r\n' +
        '  Write-Error $_\r\n  exit 1\r\n' +
        '}\r\n'
      const elevated = runPowerShellElevated(script, 60_000)
      if (elevated.ok) return { ok: true, elevated: true }

      if (elevated.outcome === 'uac-cancelled') {
        return {
          ok: false,
          elevated: true,
          reason: 'uac-cancelled',
          error:
            'Повышение прав отменено (UAC) или недоступно. Файл hosts не изменён — ' +
            'разрешите запрос администратора и повторите попытку.'
        }
      }
      const detail = elevated.stderr.trim()
      return {
        ok: false,
        elevated: true,
        reason: 'elevated-failed',
        error:
          detail ||
          `Повышенный процесс завершился с кодом ${elevated.exitCode ?? '?'}. ` +
            'Файл hosts не изменён.'
      }
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e)
      return {
        ok: false,
        elevated: false,
        reason: 'direct-failed',
        error:
          message ||
          (directError instanceof Error ? directError.message : String(directError))
      }
    } finally {
      try {
        if (existsSync(tempPath)) unlinkSync(tempPath)
      } catch {
        /* temp file — Windows will clean it eventually */
      }
    }
  }
}

export interface DnsFlushResult {
  ok: boolean
  message: string
}

/**
 * `ipconfig /flushdns` asynchronously.
 *
 * This used to be a `spawnSync` with a 10 s timeout (CA10): it froze the whole
 * main process — including every IPC call and the window — while DNS was
 * flushed. `execFile` keeps the event loop responsive and the timeout still
 * bounds a hung utility.
 */
export function flushDns(): Promise<DnsFlushResult> {
  return new Promise((resolve) => {
    const target = path.join(windowsRoot(), 'System32', 'ipconfig.exe')
    execFile(
      target,
      ['/flushdns'],
      { windowsHide: true, timeout: 10_000, encoding: 'utf8' },
      (error, _stdout, stderr) => {
        if (!error) {
          resolve({ ok: true, message: 'DNS-кэш очищен.' })
          return
        }
        const detail = `${stderr ?? ''}`.trim()
        if (detail) {
          resolve({ ok: false, message: detail })
          return
        }
        const code = (error as NodeJS.ErrnoException).code
        if (code === 'ETIMEDOUT' || (error as { killed?: boolean }).killed) {
          resolve({ ok: false, message: 'ipconfig /flushdns не завершился за 10 с.' })
          return
        }
        resolve({
          ok: false,
          message:
            code === 'ENOENT'
              ? `ipconfig.exe не найден (${target}).`
              : error.message
        })
      }
    )
  })
}

export const HOSTS_BLOCK_START = BLOCK_START
export const HOSTS_BLOCK_END = BLOCK_END
