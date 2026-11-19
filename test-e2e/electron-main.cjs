/**
 * Test-only Electron entry point for the Playwright smoke suite.
 *
 * The renderer smoke is intentionally read-only: it must not register URL
 * handlers, create/remove scheduled tasks, stop services or kill processes on
 * the developer's machine. `out/main/index.js` still does those things during
 * bootstrap/shutdown, so this wrapper disables exactly those OS integration
 * calls before loading the real main bundle.
 *
 * It does NOT change application/renderer code: the built main bundle, preload
 * and renderer are loaded unchanged. Only the OS side effects that are out of
 * scope for a renderer smoke test are stubbed.
 */
const { app } = require('electron')
const childProcess = require('node:child_process')
const { EventEmitter } = require('node:events')
const fs = require('node:fs')
const path = require('node:path')

// Never point the user's skipnet:// / tg-ws:// handlers at the dev electron.exe.
app.setAsDefaultProtocolClient = () => true
app.removeAsDefaultProtocolClient = () => true

// Auto-launch is a dev no-op, but keep the login-item API inert as well.
app.setLoginItemSettings = () => {}

// The bundled Zapret updater marker lives inside `resources/` in dev. Startup
// syncs it with the saved setting; keep the repository copy byte-identical.
const checkUpdatesMarker = path
  .join(__dirname, '..', 'resources', 'zapret', 'utils', 'check_updates.enabled')
  .toLowerCase()

function isCheckUpdatesMarker(file) {
  return typeof file === 'string' && path.resolve(file).toLowerCase() === checkUpdatesMarker
}

const originalWriteFileSync = fs.writeFileSync
fs.writeFileSync = function (file) {
  if (isCheckUpdatesMarker(file)) return
  return originalWriteFileSync.apply(this, arguments)
}

const originalUnlinkSync = fs.unlinkSync
fs.unlinkSync = function (file) {
  if (isCheckUpdatesMarker(file)) return
  return originalUnlinkSync.apply(this, arguments)
}

function executableName(command) {
  return typeof command === 'string' ? command.replace(/^.*[\\/]/, '').toLowerCase() : ''
}

/**
 * Commands that would mutate the host: protocol cleanup, service control,
 * scheduled tasks and process termination. Everything else (including `sc
 * query`, which several status checks use) passes through untouched.
 */
function shouldBlock(command, args) {
  const name = executableName(command)
  const firstArg = Array.isArray(args) ? String(args[0] ?? '').toLowerCase() : ''

  if (name === 'reg.exe') return true
  if (name === 'taskkill.exe') return true
  if (name === 'schtasks.exe') return true
  if (name === 'sc.exe') return ['start', 'stop', 'delete', 'create'].includes(firstArg)
  return false
}

function createNoopChild() {
  const child = new EventEmitter()
  child.pid = 0
  child.stdout = new EventEmitter()
  child.stderr = new EventEmitter()
  child.stdin = null
  child.unref = () => {}
  child.kill = () => true
  return child
}

const originalSpawn = childProcess.spawn
childProcess.spawn = function (command, args) {
  if (shouldBlock(command, args)) return createNoopChild()
  return originalSpawn.apply(this, arguments)
}

const originalSpawnSync = childProcess.spawnSync
childProcess.spawnSync = function (command, args) {
  if (shouldBlock(command, args)) {
    return { pid: 0, output: [], stdout: '', stderr: '', status: 0, signal: null }
  }
  return originalSpawnSync.apply(this, arguments)
}

const originalExecFile = childProcess.execFile
childProcess.execFile = function (file, args, options, callback) {
  if (shouldBlock(file, args)) {
    const cb = typeof options === 'function' ? options : callback
    if (typeof cb === 'function') process.nextTick(() => cb(null, '', ''))
    return createNoopChild()
  }
  return originalExecFile.apply(this, arguments)
}

const mainPath = path.join(__dirname, '..', 'out', 'main', 'index.js')
if (!fs.existsSync(mainPath)) {
  console.error(`E2E: ${mainPath} is missing. Run "pnpm exec electron-vite build" first.`)
  process.exit(1)
}

require(mainPath)
