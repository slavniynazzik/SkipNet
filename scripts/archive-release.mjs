/**
 * Keep a separate local copy of every released build.
 *
 * After a successful `pnpm build:win` the installer, portable archive,
 * blockmap and latest.yml are copied to `releases/v<version>/` together
 * with `SHA256SUMS.txt` and `release.json`. Each app update therefore gets
 * its own immutable folder, while GitHub Releases keeps the same files
 * separated per tag.
 *
 * `releases/` is intentionally git-ignored: it holds ~190 MB per version.
 */
import { createHash } from 'crypto'
import { copyFileSync, existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'fs'
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

const files = []
for (const name of assets) {
  const source = path.join(dist, name)
  const target = path.join(outDir, name)
  copyFileSync(source, target)
  // Hash raw bytes: reading binaries as UTF-8 would corrupt the digest.
  const sha256 = createHash('sha256').update(readFileSync(target)).digest('hex')
  files.push({ name, size: statSync(target).size, sha256 })
}

const sums = `${files.map((file) => `${file.sha256}  ${file.name}`).join('\n')}\n`
writeFileSync(path.join(outDir, 'SHA256SUMS.txt'), sums)
// Also drop the manifest next to the build so the release workflow can
// attach it to the GitHub Release.
writeFileSync(path.join(dist, 'SHA256SUMS.txt'), sums)

const manifest = {
  version,
  createdAt: new Date().toISOString(),
  files
}
writeFileSync(path.join(outDir, 'release.json'), `${JSON.stringify(manifest, null, 2)}\n`)

console.log(
  `archive-release: v${version} -> releases/v${version} (${assets.length} файла(ов) + SHA256SUMS.txt)`
)
