/**
 * Increment the app version for a new update.
 *
 * Usage:
 *   pnpm version:bump            # 1.0.0 -> 1.0.1 (patch, default)
 *   pnpm version:bump --minor    # 1.0.1 -> 1.1.0
 *   pnpm version:bump --major    # 1.1.0 -> 2.0.0
 *
 * Keeps the README version badge in sync. The release workflow refuses to
 * publish a tag that does not match package.json, so this is the single
 * place where the version of a new update is decided.
 */
import { readFileSync, writeFileSync } from 'fs'

const pkgPath = 'package.json'
const pkg = JSON.parse(readFileSync(pkgPath, 'utf8'))
const current = String(pkg.version)
const match = current.match(/^(\d+)\.(\d+)\.(\d+)$/)
if (!match) {
  console.error(`version-bump: unexpected version "${current}" (expected X.Y.Z)`)
  process.exit(1)
}

let major = Number(match[1])
let minor = Number(match[2])
let patch = Number(match[3])

const flag = process.argv[2]
if (flag === '--major') {
  major += 1
  minor = 0
  patch = 0
} else if (flag === '--minor') {
  minor += 1
  patch = 0
} else if (flag && flag !== '--patch') {
  console.error(`version-bump: unknown argument "${flag}" (use --patch, --minor or --major)`)
  process.exit(1)
} else {
  patch += 1
}

const next = `${major}.${minor}.${patch}`
pkg.version = next
writeFileSync(pkgPath, `${JSON.stringify(pkg, null, 2)}\n`)

const readmePath = 'README.md'
let readme = readFileSync(readmePath, 'utf8')
readme = readme.replace(/(badge\/version-)\d+\.\d+\.\d+(-303036)/g, `$1${next}$2`)
readme = readme.replace(/alt="Версия \d+\.\d+\.\d+"/g, `alt="Версия ${next}"`)
writeFileSync(readmePath, readme)

console.log(`version-bump: ${current} -> ${next}`)
