# SkipNet uninstaller — remove the blocks SkipNet added to the Windows hosts
# file.
#
# This runs from customUnInstall *before* electron-builder deletes $INSTDIR, so
# the script itself is about to disappear. It must therefore be self-contained:
# no modules, no helper files, no access to the app profile (which is wiped in
# the same uninstall pass).
#
# Contract:
#   - back up the current hosts file next to itself as
#     `hosts.skipnet-backup-<timestamp>`;
#   - strip the SkipNet hosts-editor block and the Adobe activation block;
#   - leave every other line (including localhost entries and other apps)
#     byte-for-byte intact, including CRLF line endings and ANSI/latin1 bytes;
#   - an unterminated marker leaves the file untouched (never swallow unrelated
#     entries after a half-written block);
#   - exit 0 when there is nothing to do, 1 when a write failed.
#
# The markers below are duplicated from src/shared/hosts-markers.ts. The unit
# suite asserts they match; changing either side is a data migration.

$ErrorActionPreference = 'Stop'

$hostsPath = Join-Path -Path $env:SystemRoot -ChildPath 'System32\drivers\etc\hosts'
if (-not (Test-Path -LiteralPath $hostsPath -PathType Leaf)) {
  exit 0
}

# ISO-8859-1 is a byte-preserving 8-bit code page: every byte 0x00-0xFF maps to
# exactly the same byte on the way back out. That keeps legacy/ANSI comment
# bytes intact, unlike a UTF-8 re-encode of the whole file.
$latin1 = [Text.Encoding]::GetEncoding(28591)

$bytes = [IO.File]::ReadAllBytes($hostsPath)
if ($bytes.Length -ge 2 -and (($bytes[0] -eq 0xFF -and $bytes[1] -eq 0xFE) -or ($bytes[0] -eq 0xFE -and $bytes[1] -eq 0xFF))) {
  # The app refuses to edit UTF-16 hosts files too. Never corrupt one here.
  Write-Warning 'SkipNet: hosts is UTF-16; leaving it unchanged.'
  exit 0
}

$text = $latin1.GetString($bytes)

$editorStart = '# --- SkipNet hosts editor BEGIN ---'
$editorEnd = '# --- SkipNet hosts editor END ---'
$adobeStart = '# --- SkipNet Adobe activation block BEGIN ---'
$adobeEnd = '# --- SkipNet Adobe activation block END ---'

function Remove-ManagedBlock {
  param(
    [string]$content,
    [string]$start,
    [string]$end
  )
  # (?ms): ^ and $ are line anchors and `.` also crosses newlines. The END
  # marker is mandatory, so a truncated BEGIN block is left alone instead of
  # deleting the rest of the file.
  $eol = '(?:\r\n|\n|\r)'
  $pattern = '(?ms)^' + [regex]::Escape($start) + '[ \t]*' + $eol +
    '.*?^' + [regex]::Escape($end) + '[ \t]*(?:' + $eol + '|\z)'
  return [regex]::Replace($content, $pattern, '')
}

$newText = Remove-ManagedBlock -content $text -start $editorStart -end $editorEnd
$newText = Remove-ManagedBlock -content $newText -start $adobeStart -end $adobeEnd

if ($newText -eq $text) {
  # Nothing SkipNet-owned in the file: no backup, no write, success.
  Write-Verbose 'SkipNet: no managed hosts block found.'
  exit 0
}

$dir = Split-Path -Parent $hostsPath
$stamp = Get-Date -Format 'yyyyMMdd-HHmmssfff'
$backup = Join-Path $dir ('hosts.skipnet-backup-' + $stamp)
try {
  Copy-Item -LiteralPath $hostsPath -Destination $backup -Force -ErrorAction Stop
} catch {
  Write-Error ('SkipNet: could not back up hosts: ' + $_.Exception.Message)
  exit 1
}

$newBytes = $latin1.GetBytes($newText)
$tmp = Join-Path $dir ('hosts.skipnet-' + [Guid]::NewGuid().ToString('N') + '.tmp')

try {
  # Temp file in the same directory (same volume) -> Move-Item is an atomic
  # replace. Flush($true) is FlushFileBuffers, so the bytes hit the disk before
  # the rename.
  $stream = [IO.File]::Open($tmp, [IO.FileMode]::CreateNew, [IO.FileAccess]::Write, [IO.FileShare]::None)
  try {
    $stream.Write($newBytes, 0, $newBytes.Length)
    $stream.Flush($true)
  } finally {
    $stream.Dispose()
  }
  Move-Item -LiteralPath $tmp -Destination $hostsPath -Force -ErrorAction Stop
} catch {
  if (Test-Path -LiteralPath $tmp) {
    Remove-Item -LiteralPath $tmp -Force -ErrorAction SilentlyContinue
  }
  Write-Error ('SkipNet: hosts cleanup failed: ' + $_.Exception.Message)
  exit 1
}

exit 0
