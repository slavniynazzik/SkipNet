/**
 * Regenerate `resources/binaries.sha256` — the integrity manifest for every
 * executable payload SkipNet runs elevated (Zapret strategies + winws.exe +
 * WinDivert + the bundled PowerShell test, and TgWsProxy).
 *
 * Format is plain sha256sum output (`<64hex>  <path relative to resources/>`)
 * so it can be verified by `src/main/core/binary-integrity.ts`, by
 * `scripts/verify-dist.mjs` and by ordinary tooling.
 *
 * Run directly: `node scripts/build-binary-manifest.mjs`
 * Imported by: `scripts/verify-dist.mjs` (verification helpers)
 */
import { createHash } from 'crypto'
import { existsSync, readdirSync, readFileSync, writeFileSync } from 'fs'
import path from 'path'
import { fileURLToPath } from 'url'

export const MANIFEST_NAME = 'binaries.sha256'

const EXECUTABLE_EXTENSIONS = new Set([
  '.bat',
  '.cmd',
  '.com',
  '.cpl',
  '.dll',
  '.exe',
  '.js',
  '.msi',
  '.ps1',
  '.psm1',
  '.scr',
  '.sys',
  '.vbs'
])

/** Files the build cannot ship without. Verified after generation. */
export const REQUIRED_MANIFEST_ENTRIES = [
  'zapret/bin/winws.exe',
  'zapret/bin/WinDivert64.sys',
  'zapret/bin/WinDivert.dll',
  'zapret/bin/cygwin1.dll',
  'zapret/utils/test zapret.ps1',
  'tgws/TgWsProxy_windows.exe'
]

const COMPONENT_DIRS = ['zapret', 'tgws']

function sha256(file) {
  return createHash('sha256').update(readFileSync(file)).digest('hex')
}

function normalizeRelative(relative) {
  if (typeof relative !== 'string' || !relative.trim()) {
    throw new Error(`invalid manifest path: ${JSON.stringify(relative)}`)
  }
  if (
    path.isAbsolute(relative) ||
    /^[a-zA-Z]:/.test(relative) ||
    relative.startsWith('/') ||
    relative.startsWith('\\')
  ) {
    throw new Error(`absolute manifest path is not allowed: ${relative}`)
  }
  const segments = relative.replace(/\\/g, '/').split('/')
  if (segments.some((segment) => segment === '..' || segment === '\0')) {
    throw new Error(`path traversal in manifest entry: ${relative}`)
  }
  const normalized = segments.filter((segment) => segment && segment !== '.').join('/')
  if (!normalized) throw new Error(`empty manifest path: ${JSON.stringify(relative)}`)
  return normalized
}

/** Every executable file under `resources/<component>/`, sorted. */
export function collectManifestFiles(resourcesRoot) {
  const files = []
  for (const component of COMPONENT_DIRS) {
    const dir = path.join(resourcesRoot, component)
    if (!existsSync(dir)) continue
    const walk = (current, prefix) => {
      for (const entry of readdirSync(current, { withFileTypes: true })) {
        if (entry.isSymbolicLink()) continue
        const absolute = path.join(current, entry.name)
        if (entry.isDirectory()) {
          walk(absolute, `${prefix}${entry.name}/`)
          continue
        }
        if (!entry.isFile()) continue
        if (!EXECUTABLE_EXTENSIONS.has(path.extname(entry.name).toLowerCase())) continue
        files.push(`${prefix}${entry.name}`)
      }
    }
    walk(dir, `${component}/`)
  }
  return files.sort()
}

export function parseManifestText(text) {
  const entries = new Map()
  const lines = text.split(/\r?\n/)
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim()
    if (!line || line.startsWith('#')) continue
    const match = line.match(/^([0-9a-fA-F]{64}) [ *](.+)$/)
    if (!match) throw new Error(`invalid ${MANIFEST_NAME} line ${i + 1}`)
    entries.set(normalizeRelative(match[2].trim()), match[1].toLowerCase())
  }
  return entries
}

export function buildManifestText(resourcesRoot) {
  const lines = []
  for (const relative of collectManifestFiles(resourcesRoot)) {
    const absolute = path.join(resourcesRoot, ...relative.split('/'))
    lines.push(`${sha256(absolute)}  ${relative}`)
  }
  return { text: lines.join('\n') + '\n', entries: lines.length }
}

/**
 * Verify `resourcesRoot/binaries.sha256` against the files on disk.
 * Returns a list of human-readable problems (empty array = OK).
 */
export function verifyManifestDir(resourcesRoot) {
  const errors = []
  const manifestFile = path.join(resourcesRoot, MANIFEST_NAME)
  if (!existsSync(manifestFile)) {
    return [`missing ${MANIFEST_NAME}`]
  }

  let entries
  try {
    entries = parseManifestText(readFileSync(manifestFile, 'utf8'))
  } catch (e) {
    return [`${MANIFEST_NAME} is unreadable: ${e.message}`]
  }
  if (entries.size === 0) errors.push(`${MANIFEST_NAME} is empty`)

  for (const required of REQUIRED_MANIFEST_ENTRIES) {
    if (!entries.has(required)) errors.push(`${MANIFEST_NAME} does not cover ${required}`)
  }

  for (const relative of collectManifestFiles(resourcesRoot)) {
    if (!entries.has(relative)) {
      errors.push(`${relative} is executable but missing from ${MANIFEST_NAME}`)
    }
  }

  for (const [relative, expected] of entries) {
    let normalized
    try {
      normalized = normalizeRelative(relative)
    } catch (e) {
      errors.push(e.message)
      continue
    }
    const absolute = path.join(resourcesRoot, ...normalized.split('/'))
    if (!absolute.startsWith(path.resolve(resourcesRoot) + path.sep)) {
      errors.push(`path escapes resources: ${relative}`)
      continue
    }
    if (!existsSync(absolute)) {
      errors.push(`missing file listed in ${MANIFEST_NAME}: ${relative}`)
      continue
    }
    if (sha256(absolute) !== expected) {
      errors.push(`sha256 mismatch: ${relative}`)
    }
  }

  return errors
}

function main() {
  const root = path.resolve(process.cwd(), 'resources')
  if (!existsSync(root)) throw new Error(`resources directory not found: ${root}`)

  const missing = REQUIRED_MANIFEST_ENTRIES.filter(
    (relative) => !existsSync(path.join(root, ...relative.split('/')))
  )
  if (missing.length) {
    console.error(`binary manifest FAILED: required files are missing:\n - ${missing.join('\n - ')}`)
    process.exit(1)
  }

  const { text, entries } = buildManifestText(root)
  const manifestFile = path.join(root, MANIFEST_NAME)
  writeFileSync(manifestFile, text, 'utf8')
  console.log(`binary manifest OK: ${entries} entries -> resources/${MANIFEST_NAME}`)
}

const invokedDirectly =
  process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url))

if (invokedDirectly) {
  try {
    main()
  } catch (e) {
    console.error(`binary manifest FAILED: ${e.message}`)
    process.exit(1)
  }
}
