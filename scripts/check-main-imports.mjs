#!/usr/bin/env node
/**
 * Guard against the import cycle that used to run through the `src/main/index.ts`
 * barrel: index -> resolve/* -> index.
 *
 * Files under `src/main/resolve` and `src/main/config` must never import the
 * barrel (`..` or `../index`), directly or dynamically. They may import the
 * leaf `resolve/window-ref` instead.
 */
import { readdirSync, readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const targets = ['src/main/resolve', 'src/main/config']
const BARREL_RE = /(?:from\s+['"](?:\.\.|\.\.\/index)['"]|require\(\s*['"](?:\.\.|\.\.\/index)['"]\s*\)|import\(\s*['"](?:\.\.|\.\.\/index)['"]\s*\))/

function collect(dir) {
  const out = []
  const entries = readdirSync(dir, { withFileTypes: true })
  for (const entry of entries) {
    const full = path.join(dir, entry.name)
    if (entry.isDirectory()) out.push(...collect(full))
    else if (/\.(?:ts|tsx|mts|cts)$/.test(entry.name)) out.push(full)
  }
  return out
}

const offenders = []
for (const target of targets) {
  const dir = path.join(root, target)
  let entries
  try {
    entries = collect(dir)
  } catch {
    continue // directory removed or renamed: nothing to check
  }
  for (const file of entries) {
    const lines = readFileSync(file, 'utf8').split(/\r?\n/)
    lines.forEach((line, index) => {
      if (BARREL_RE.test(line)) {
        offenders.push({
          file: path.relative(root, file).replace(/\\/g, '/'),
          line: index + 1,
          text: line.trim()
        })
      }
    })
  }
}

if (offenders.length > 0) {
  console.error('Forbidden barrel imports from src/main/index.ts:')
  for (const item of offenders) console.error(`  ${item.file}:${item.line}  ${item.text}`)
  console.error('\nUse the leaf module (e.g. resolve/window-ref) instead.')
  process.exit(1)
}

console.log(`check-main-imports: ${targets.join(', ')} — no barrel imports`)
