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
  readdirSync,
  renameSync,
  statSync,
  unlinkSync,
  writeFileSync,
  writeSync
} from 'node:fs'
import { createHash, randomUUID } from 'node:crypto'
import path from 'node:path'
import { execFile } from 'node:child_process'
import { psQuote, runPowerShellElevated } from '../utils/elevated'
import { secureStagingDir } from '../utils/secure-staging'
import { sysBin, windowsRoot } from '../utils/sys-bin'
import { HOSTS_EDITOR_BLOCK_END, HOSTS_EDITOR_BLOCK_START } from '../../shared/hosts-markers'

const BLOCK_START = HOSTS_EDITOR_BLOCK_START
const BLOCK_END = HOSTS_EDITOR_BLOCK_END

/**
 * UTF-16 hosts files are unreadable to the latin1 round-trip this module uses
 * (and to winws.exe / Windows itself). Saving one silently corrupts every
 * managed entry, so mutations refuse to proceed instead of writing mojibake
 * back into the file (H6).
 */
export const HOSTS_UTF16_ERROR =
  'Файл hosts сохранён в кодировке UTF-16. Откройте его в Блокноте и сохраните ' +
  'как ANSI или UTF-8 (без BOM), затем повторите попытку.'

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

/** Decode hosts bytes, rejecting a UTF-16 BOM with a user-facing error (H6). */
export function decodeHostsBytes(buf: Buffer): string {
  if (buf.length >= 2) {
    const first = buf[0]
    const second = buf[1]
    // UTF-16LE BOM = FF FE, UTF-16BE BOM = FE FF.
    if ((first === 0xff && second === 0xfe) || (first === 0xfe && second === 0xff)) {
      throw new Error(HOSTS_UTF16_ERROR)
    }
  }
  return buf.toString('latin1')
}

/** Read the hosts file byte-for-byte (latin1 round-trips arbitrary bytes). */
export function readHostsRaw(): string {
  try {
    return decodeHostsBytes(readFileSync(windowsHostsPath()))
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
  return decodeHostsBytes(readFileSync(target))
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
    return { content: decodeHostsBytes(readFileSync(target)), ok: true }
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

export const HOSTS_TEMP_PREFIX = 'hosts.skipnet-'
/** Leftover temp files older than this were abandoned by a crashed write. */
export const HOSTS_TEMP_MAX_AGE_MS = 60 * 60 * 1000

/**
 * Pure predicate for the stale-temp sweep: a real SkipNet temp file, inside
 * the hosts directory, older than `maxAgeMs`. Anything else is left alone —
 * another file that merely looks similar must never be deleted from the
 * privileged `drivers\etc` directory.
 */
export function isStaleHostsTempFile(
  file: string,
  hostsDir: string,
  mtimeMs: number,
  now: number = Date.now(),
  maxAgeMs: number = HOSTS_TEMP_MAX_AGE_MS
): boolean {
  if (!Number.isFinite(mtimeMs) || !Number.isFinite(now)) return false
  const name = path.basename(file)
  if (!name.startsWith(HOSTS_TEMP_PREFIX) || !name.endsWith('.tmp')) return false
  if (path.resolve(path.dirname(file)) !== path.resolve(hostsDir)) return false
  return now - mtimeMs > maxAgeMs
}

let hostsTempSwept = false

/** Allow the suite to exercise the first-apply sweep more than once. */
export function resetHostsTempSweepForTesting(): void {
  hostsTempSwept = false
}

/**
 * Best-effort: on the first apply of the session remove abandoned
 * `hosts.skipnet-*.tmp` files from a previous crash or a killed elevated run.
 * Only files older than an hour are touched, so a concurrent write (another
 * instance, an AV retry) is not disturbed.
 */
export function sweepStaleHostsTemps(
  hostsDir: string = path.dirname(windowsHostsPath()),
  now: number = Date.now()
): number {
  if (hostsTempSwept) return 0
  hostsTempSwept = true
  let removed = 0
  try {
    for (const entry of readdirSync(hostsDir, { withFileTypes: true })) {
      if (!entry.isFile()) continue
      const file = path.join(hostsDir, entry.name)
      let mtimeMs: number
      try {
        mtimeMs = statSync(file).mtimeMs
      } catch {
        continue
      }
      if (!isStaleHostsTempFile(file, hostsDir, mtimeMs, now)) continue
      try {
        unlinkSync(file)
        removed++
      } catch {
        /* best effort — a locked temp file is retried next launch */
      }
    }
  } catch {
    /* drivers\etc unreadable: nothing to sweep */
  }
  if (removed > 0) {
    console.warn(`[hosts] removed ${removed} stale temp file(s) from ${hostsDir}`)
  }
  return removed
}

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
 * Build the elevated PowerShell body that replaces `target` with the staged
 * payload.
 *
 * The staged file is read **exactly once** into `$bytes`; the hash is computed
 * from those same bytes and those same bytes are written. There is no second
 * read after hashing, so a process that swaps the staged file while the UAC
 * prompt is open cannot inject hosts entries. The temporary file lives in the
 * `etc` directory itself (same volume → atomic replace), is fsync'd via
 * `FileStream.Flush($true)`, and is moved over `target` in one step.
 */
export function buildElevatedHostsWriteScript(
  stagedPath: string,
  target: string,
  expectedSha256: string
): string {
  return [
    "$ErrorActionPreference = 'Stop'",
    `$expected = '${expectedSha256}'`,
    `$bytes = [IO.File]::ReadAllBytes(${psQuote(stagedPath)})`,
    '$sha = [Security.Cryptography.SHA256]::Create()',
    'try {',
    "  $actual = ([BitConverter]::ToString($sha.ComputeHash($bytes)) -replace '-', '').ToLower()",
    '} finally {',
    '  $sha.Dispose()',
    '}',
    "if ($actual -ne $expected) { Write-Error 'hosts checksum mismatch'; exit 1 }",
    `$target = ${psQuote(target)}`,
    '$dir = [IO.Path]::GetDirectoryName($target)',
    "$tmp = [IO.Path]::Combine($dir, 'hosts.skipnet-' + [Guid]::NewGuid().ToString('N') + '.tmp')",
    'try {',
    '  $fs = [IO.File]::Open($tmp, [IO.FileMode]::CreateNew, [IO.FileAccess]::Write, [IO.FileShare]::None)',
    '  try {',
    '    $fs.Write($bytes, 0, $bytes.Length)',
    '    $fs.Flush($true)',
    '  } finally {',
    '    $fs.Dispose()',
    '  }',
    '  Move-Item -LiteralPath $tmp -Destination $target -Force -ErrorAction Stop',
    '} catch {',
    '  if (Test-Path -LiteralPath $tmp) {',
    '    Remove-Item -LiteralPath $tmp -Force -ErrorAction SilentlyContinue',
    '  }',
    '  Write-Error $_',
    '  exit 1',
    '}',
    'exit 0'
  ].join('\r\n')
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
  // First apply of this session: clear abandoned temp files. Runs before the
  // write so a previous crash cannot leave privileged garbage behind forever.
  sweepStaleHostsTemps(path.dirname(target))
  try {
    writeHostsFileAtomically(target, Buffer.from(content, 'latin1'))
    return { ok: true, elevated: false }
  } catch (directError) {
    const directMessage =
      directError instanceof Error ? directError.message : String(directError)
    // The payload is staged in the admin-only directory, not %TEMP%: the
    // elevated process reads it after the UAC prompt, from a path a
    // medium-integrity process cannot write.
    let stagedPath: string | null = null
    try {
      const payload = Buffer.from(content, 'latin1')
      stagedPath = path.join(
        secureStagingDir('hosts'),
        `skipnet-hosts-new-${randomUUID()}.txt`
      )
      writeFileSync(stagedPath, payload, { flag: 'wx', mode: 0o700 })
      const expected = createHash('sha256').update(payload).digest('hex')
      const elevated = runPowerShellElevated(
        buildElevatedHostsWriteScript(stagedPath, target, expected),
        60_000
      )
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
          `${message || 'Не удалось подготовить файл hosts для elevated-записи.'} ` +
          `Прямая запись: ${directMessage}`
      }
    } finally {
      if (stagedPath) {
        try {
          if (existsSync(stagedPath)) unlinkSync(stagedPath)
        } catch {
          /* staging file — the admin-only folder can be cleaned later */
        }
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
    const target = sysBin('ipconfig.exe')
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
