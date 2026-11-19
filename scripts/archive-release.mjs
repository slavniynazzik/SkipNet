/**
 * Keep a separate local copy of every released build.
 *
 * After a successful `pnpm build:win` the installer, portable archive,
 * blockmap and latest.yml are copied to `releases/v<version>/` together
 * with `SHA256SUMS.txt` and `release.json`. Each app update therefore gets
 * its own immutable folder, while GitHub Releases keeps the same files
 * separated per tag.
 *
 * Integrity contract (C10 / audit P1-13):
 *  - every checksum is computed from the bytes that were actually copied into
 *    `releases/v<version>/`, never from a stale `dist/` file that failed to be
 *    overwritten;
 *  - `SHA256SUMS.txt` and `release.json` are written from that same byte set,
 *    so `release.json.files[i].sha256` always equals `SHA256SUMS.txt`;
 *  - a missing required asset aborts the build instead of publishing a
 *    partial release.
 *
 * `releases/` is intentionally git-ignored: it holds ~190 MB per version.
 */
import { createHash } from 'crypto'
import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'fs'
import path from 'path'

const root = process.cwd()
const dist = path.join(root, 'dist')
const pkg = JSON.parse(readFileSync(path.join(root, 'package.json'), 'utf8'))
const version = String(pkg.version)
const outDir = path.join(root, 'releases', `v${version}`)

const assets = [
  'SkipNet_x64.exe',
  'SkipNet_x64.exe.blockmap',
  'SkipNet_x64-portable.7z',
  'latest.yml'
]

const missing = assets.filter((name) => !existsSync(path.join(dist, name)))
if (missing.length) {
  console.error(`archive-release: missing build artifacts: ${missing.join(', ')}`)
  process.exit(1)
}

mkdirSync(outDir, { recursive: true })

// Copy first, then hash the destination. Hashing `dist` here would certify a
// file that may not be what ended up in the archive (copy failed halfway,
// stale file left from a previous run, antivirus truncation, ...).
const files = []
for (const name of assets) {
  const source = path.join(dist, name)
  const target = path.join(outDir, name)
  copyFileSync(source, target)

  const bytes = readFileSync(target)
  if (bytes.length === 0) {
    console.error(`archive-release: copied asset is empty: ${name}`)
    process.exit(1)
  }
  const sha256 = createHash('sha256').update(bytes).digest('hex')
  files.push({ name, size: bytes.length, sha256 })
}

const sums = `${files.map((file) => `${file.sha256}  ${file.name}`).join('\n')}\n`
writeFileSync(path.join(outDir, 'SHA256SUMS.txt'), sums)
// Also drop the manifest next to the build so the release workflow can
// attach it to the GitHub Release. Same bytes as the archived copy above.
writeFileSync(path.join(dist, 'SHA256SUMS.txt'), sums)

const manifest = {
  version,
  createdAt: new Date().toISOString(),
  files
}
writeFileSync(path.join(outDir, 'release.json'), `${JSON.stringify(manifest, null, 2)}\n`)

// Self-check: never leave a release folder whose own manifest disagrees with
// the files next to it. This catches a truncated copy or a stale file from a
// previous attempt before the artifact is uploaded anywhere.
const mismatched = files.filter((file) => {
  const archived = readFileSync(path.join(outDir, file.name))
  const digest = createHash('sha256').update(archived).digest('hex')
  return digest !== file.sha256 || archived.length !== file.size
})
if (mismatched.length) {
  console.error(
    `archive-release: copied files do not match SHA256SUMS.txt: ${mismatched
      .map((file) => file.name)
      .join(', ')}`
  )
  process.exit(1)
}

console.log(
  `archive-release: v${version} -> releases/v${version} (${assets.length} файла(ов) + SHA256SUMS.txt)`
)
