/**
 * Sanity-check the packaged Windows build.
 *
 * Historically a log file that was being written during `electron-builder`
 * packaging ended up inside `app.asar`. Its size kept growing between stat()
 * and read(), so every following entry got a wrong offset: the archive looked
 * fine in a directory listing but `SkipNet.exe` exited with code 1 on launch.
 *
 * This script re-parses the asar header and verifies that entry offsets are
 * contiguous and that the package entry point really contains JS. It also
 * checks the runtime resources the installer must ship.
 */
import { existsSync, readdirSync, readFileSync, statSync } from 'fs'
import path from 'path'

const root = process.cwd()
const dist = path.join(root, 'dist')
const unpacked = path.join(dist, 'win-unpacked')
const asarPath = path.join(unpacked, 'resources', 'app.asar')

const errors = []
function check(condition, message) {
  if (!condition) errors.push(message)
}

check(existsSync(asarPath), `missing ${asarPath}`)
if (!errors.length) {
  const buf = readFileSync(asarPath)
  const headerJsonSize = buf.readUInt32LE(12)
  const header = JSON.parse(buf.subarray(16, 16 + headerJsonSize).toString())
  const dataStart = 8 + buf.readUInt32LE(4)
  const dataBytes = buf.length - dataStart

  const entries = []
  const walk = (node, prefix) => {
    for (const [name, value] of Object.entries(node.files ?? {})) {
      const entryPath = prefix ? `${prefix}/${name}` : name
      if (value.files) walk(value, entryPath)
      else if (value.offset !== undefined) {
        entries.push({ path: entryPath, offset: Number(value.offset), size: value.size })
      }
    }
  }
  walk(header, '')
  entries.sort((a, b) => a.offset - b.offset)

  check(entries.length > 0, 'app.asar has no file entries')
  let end = 0
  for (const entry of entries) {
    check(
      entry.offset === end,
      `app.asar entry ${entry.path} starts at ${entry.offset}, expected ${end} (archive offsets are corrupt)`
    )
    end = entry.offset + entry.size
  }
  check(end === dataBytes, `app.asar data ends at ${end}, archive has ${dataBytes} bytes (offsets are corrupt)`)

  const logEntries = entries.filter((entry) => entry.path.endsWith('.log'))
  check(logEntries.length === 0, `app.asar contains log files: ${logEntries.map((e) => e.path).join(', ')}`)

  const readEntry = (entryPath) => {
    const entry = entries.find((item) => item.path === entryPath)
    if (!entry) return null
    return buf.subarray(dataStart + entry.offset, dataStart + entry.offset + entry.size).toString()
  }

  const pkgRaw = readEntry('package.json')
  check(!!pkgRaw, 'app.asar is missing package.json')
  let pkg = null
  if (pkgRaw) {
    try {
      pkg = JSON.parse(pkgRaw)
    } catch {
      errors.push('app.asar package.json is not valid JSON')
    }
  }
  if (pkg) {
    check(pkg.name === 'skipnet', `unexpected package name: ${pkg.name}`)
    const mainPath = String(pkg.main ?? '').replace(/^\.\//, '')
    const mainRaw = readEntry(mainPath)
    check(!!mainRaw, `app.asar is missing main entry ${mainPath}`)
    check(
      !!mainRaw && (mainRaw.startsWith('"use strict"') || mainRaw.includes('require(')),
      `main entry ${mainPath} does not look like JavaScript`
    )
  }
}

const appUpdate = path.join(unpacked, 'resources', 'app-update.yml')
check(existsSync(appUpdate), 'missing app-update.yml')
if (existsSync(appUpdate)) {
  const yml = readFileSync(appUpdate, 'utf8')
  check(/owner:\s*slavniynazzik/.test(yml), 'app-update.yml owner is not slavniynazzik')
  check(/repo:\s*SkipNet/.test(yml), 'app-update.yml repo is not SkipNet')
}

const tgws = path.join(unpacked, 'resources', 'tgws', 'TgWsProxy_windows.exe')
check(existsSync(tgws), 'missing bundled TgWsProxy_windows.exe')

const zapret = path.join(unpacked, 'resources', 'zapret')
check(existsSync(zapret), 'missing bundled zapret directory')
if (existsSync(zapret)) {
  const bats = readdirSync(zapret).filter((name) => /^general.*\.bat$/i.test(name))
  check(bats.length === 22, `expected 22 zapret strategies, found ${bats.length}`)
  check(existsSync(path.join(zapret, 'service.bat')), 'missing zapret service.bat')
}

for (const asset of ['icon.ico', 'icon.png', 'icon_on.ico', 'icon_on.png', 'icon_off.ico', 'icon_off.png']) {
  check(existsSync(path.join(unpacked, 'resources', asset)), `missing resources/${asset}`)
}

const installer = path.join(dist, 'SkipNet_x64.exe')
check(existsSync(installer), 'missing dist/SkipNet_x64.exe')
if (existsSync(installer)) check(statSync(installer).size > 50 * 1024 * 1024, 'installer is unexpectedly small')

if (errors.length) {
  console.error('dist verification FAILED:')
  for (const message of errors) console.error(` - ${message}`)
  process.exit(1)
}

console.log('dist verification OK')
