/**
 * Custom wallpapers for the SkipNet window.
 *
 * Three sources are supported:
 *  - a local image (png/jpg/webp/avif/gif);
 *  - a local video (mp4/webm/m4v) played muted and looped;
 *  - an item downloaded from the Steam Workshop for Wallpaper Engine
 *    (app id 431960). Steam keeps those under
 *    `<library>\steamapps\workshop\content\431960\<item id>`.
 *
 * Wallpaper Engine "Scene" items are `.pkg` archives that only the Wallpaper
 * Engine runtime can decode, so for those we fall back to the item's
 * `preview.jpg` and tell the user why. Video/image Workshop items play
 * natively through Chromium.
 *
 * Files are served to the renderer through the `skipnet-media://` protocol so
 * the renderer never gets raw filesystem access. Only paths registered by this
 * module (the current wallpaper plus scanned Workshop assets) are served.
 */

import { createReadStream, existsSync, readFileSync, readdirSync, statSync } from 'node:fs'
import { Readable } from 'node:stream'
import path from 'node:path'
import os from 'node:os'
import { spawnSync } from 'node:child_process'
import { BrowserWindow, dialog, protocol, shell } from 'electron'

const WALLPAPER_ENGINE_APP_ID = '431960'
const MEDIA_SCHEME = 'skipnet-media'

const IMAGE_EXT = new Set(['.png', '.jpg', '.jpeg', '.webp', '.avif', '.gif', '.bmp'])
const VIDEO_EXT = new Set(['.mp4', '.webm', '.m4v', '.mov', '.mkv'])

const MIME: Record<string, string> = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.avif': 'image/avif',
  '.gif': 'image/gif',
  '.bmp': 'image/bmp',
  '.mp4': 'video/mp4',
  '.webm': 'video/webm',
  '.m4v': 'video/x-m4v',
  '.mov': 'video/quicktime',
  '.mkv': 'video/x-matroska'
}

export interface WorkshopWallpaper {
  id: string
  title: string
  /** Wallpaper Engine project type: Scene / Video / Web / Application. */
  type: string
  /** True when Chromium can render the item without Wallpaper Engine. */
  playable: boolean
  /** Absolute path used as wallpaper (media file or preview image). */
  mediaPath: string
  /** Absolute path of the preview image, when present. */
  previewPath?: string
  /** Folder of the Workshop item. */
  dir: string
}

export interface WallpaperState {
  enabled: boolean
  kind: 'none' | 'image' | 'video'
  /** `skipnet-media://` URL for the wallpaper, when available. */
  url?: string
  previewUrl?: string
  title?: string
  note?: string
  opacity: number
  blur: number
  dim: number
}

// Paths the custom protocol is allowed to serve. Kept in sync by
// `resolveWallpaper` and `listWorkshopWallpapers`.
const allowedMedia = new Set<string>()

/**
 * Whitelist a file for the media protocol. Only real image/video extensions
 * are accepted: without this check a wallpaper path pointing at, say,
 * `config.yaml` would turn `skipnet-media://` into an arbitrary-file read.
 */
function allow(file: string | undefined): boolean {
  if (!file) return false
  const resolved = path.resolve(file)
  if (!classify(resolved)) return false
  allowedMedia.add(resolved.toLowerCase())
  return true
}

function mediaUrl(file: string): string {
  const token = Buffer.from(path.resolve(file), 'utf8').toString('base64url')
  return `${MEDIA_SCHEME}://local/?p=${token}`
}

function mimeFor(file: string): string {
  return MIME[path.extname(file).toLowerCase()] ?? 'application/octet-stream'
}

function clamp(value: unknown, min: number, max: number, fallback: number): number {
  const n = typeof value === 'number' && Number.isFinite(value) ? value : fallback
  return Math.min(max, Math.max(min, Math.round(n)))
}

/** Register the privileged scheme. MUST run before Electron is ready. */
export function registerWallpaperScheme(): void {
  protocol.registerSchemesAsPrivileged([
    {
      scheme: MEDIA_SCHEME,
      privileges: {
        standard: true,
        secure: true,
        supportFetchAPI: true,
        stream: true,
        bypassCSP: true
      }
    }
  ])
}

function serveMedia(file: string, request: Request): Response {
  // Defence in depth: even if a bad path somehow made it into the allow-list,
  // never serve anything that is not an image or video.
  if (!classify(file)) return new Response('forbidden', { status: 403 })
  let size = 0
  try {
    size = statSync(file).size
  } catch {
    return new Response('not found', { status: 404 })
  }

  const headers: Record<string, string> = {
    'Content-Type': mimeFor(file),
    'Accept-Ranges': 'bytes',
    'Cache-Control': 'private, max-age=3600'
  }

  const range = request.headers.get('Range')
  if (range) {
    const match = /^bytes=(\d*)-(\d*)$/i.exec(range.trim())
    if (match) {
      const total = size
      let start = match[1] ? Number.parseInt(match[1], 10) : 0
      let end = match[2] ? Number.parseInt(match[2], 10) : total - 1
      // Suffix form (`bytes=-500`) means "the last 500 bytes".
      if (!match[1] && match[2]) {
        start = Math.max(0, total - Number.parseInt(match[2], 10))
        end = total - 1
      }
      if (!Number.isFinite(start) || !Number.isFinite(end) || start > end || start >= total) {
        return new Response(null, {
          status: 416,
          headers: { 'Content-Range': `bytes */${total}` }
        })
      }
      end = Math.min(end, total - 1)
      const stream = Readable.toWeb(createReadStream(file, { start, end }))
      return new Response(stream as unknown as ReadableStream, {
        status: 206,
        headers: {
          ...headers,
          'Content-Range': `bytes ${start}-${end}/${total}`,
          'Content-Length': String(end - start + 1)
        }
      })
    }
  }

  const stream = Readable.toWeb(createReadStream(file))
  return new Response(stream as unknown as ReadableStream, {
    headers: { ...headers, 'Content-Length': String(size) }
  })
}

/** Register the `skipnet-media://` handler. Call after `app.whenReady()`. */
export function initWallpaperProtocol(): void {
  protocol.handle(MEDIA_SCHEME, async (request) => {
    try {
      const url = new URL(request.url)
      const token = url.searchParams.get('p')
      if (!token) return new Response('bad request', { status: 400 })
      const file = Buffer.from(token, 'base64url').toString('utf8')
      if (!file || !allowedMedia.has(path.resolve(file).toLowerCase())) {
        return new Response('forbidden', { status: 403 })
      }
      if (!existsSync(file)) return new Response('not found', { status: 404 })
      return serveMedia(file, request)
    } catch {
      return new Response('bad request', { status: 400 })
    }
  })
}

// ---- Steam libraries ------------------------------------------------------

function regQuery(key: string, value: string): string | null {
  try {
    const r = spawnSync('reg.exe', ['query', key, '/v', value], {
      windowsHide: true,
      timeout: 5000,
      encoding: 'utf8'
    })
    const out = `${r.stdout ?? ''}\n${r.stderr ?? ''}`
    const match = new RegExp(`${value}\\s+REG_SZ\\s+(.+)$`, 'im').exec(out)
    return match?.[1]?.trim() || null
  } catch {
    return null
  }
}

function steamRoots(): string[] {
  const roots = new Set<string>()
  const candidates: Array<string | null> = []
  if (process.platform === 'win32') {
    candidates.push(
      regQuery('HKCU\\Software\\Valve\\Steam', 'SteamPath'),
      regQuery('HKLM\\SOFTWARE\\WOW6432Node\\Valve\\Steam', 'InstallPath'),
      regQuery('HKLM\\SOFTWARE\\Valve\\Steam', 'InstallPath'),
      process.env.ProgramFiles ? path.join(process.env.ProgramFiles, 'Steam') : null,
      process.env['ProgramFiles(x86)']
        ? path.join(process.env['ProgramFiles(x86)']!, 'Steam')
        : null
    )
  } else if (process.platform === 'darwin') {
    candidates.push(path.join(os.homedir(), 'Library', 'Application Support', 'Steam'))
  } else {
    candidates.push(
      path.join(os.homedir(), '.steam', 'steam'),
      path.join(os.homedir(), '.local', 'share', 'Steam')
    )
  }
  for (const candidate of candidates) {
    if (candidate && existsSync(candidate)) roots.add(path.resolve(candidate))
  }
  return [...roots]
}

interface SteamLibrary {
  path: string
  workshopDir?: string
}

function readLibraryFolders(steamRoot: string): string[] {
  const vdf = path.join(steamRoot, 'steamapps', 'libraryfolders.vdf')
  if (!existsSync(vdf)) return []
  try {
    const text = readFileSync(vdf, 'utf8')
    const libraries: string[] = []
    const re = /"path"\s+"([^"]+)"/gi
    let match: RegExpExecArray | null
    while ((match = re.exec(text)) !== null) {
      // VDF escapes backslashes as `\\`.
      libraries.push(match[1].replace(/\\\\/g, '\\'))
    }
    return libraries
  } catch {
    return []
  }
}

/** All Steam libraries that contain downloaded Wallpaper Engine items. */
function wallpaperLibraries(): SteamLibrary[] {
  const roots = steamRoots()
  const all = new Set<string>()
  for (const root of roots) {
    all.add(root)
    for (const lib of readLibraryFolders(root)) all.add(path.resolve(lib))
  }
  const result: SteamLibrary[] = []
  for (const lib of all) {
    const workshop = path.join(lib, 'steamapps', 'workshop', 'content', WALLPAPER_ENGINE_APP_ID)
    result.push({ path: lib, workshopDir: existsSync(workshop) ? workshop : undefined })
  }
  return result.filter((l) => l.workshopDir)
}

interface ProjectJson {
  title?: string
  type?: string
  file?: string
  preview?: string
}

function readProject(dir: string): ProjectJson | null {
  try {
    const file = path.join(dir, 'project.json')
    // Refuse absurdly large metadata files (Workshop content is untrusted).
    if (statSync(file).size > 1024 * 1024) return null
    const project = JSON.parse(readFileSync(file, 'utf8')) as ProjectJson
    if (!project || typeof project !== 'object') return null
    return project
  } catch {
    return null
  }
}

function classify(file: string | undefined): 'image' | 'video' | null {
  if (!file) return null
  const ext = path.extname(file).toLowerCase()
  if (IMAGE_EXT.has(ext)) return 'image'
  if (VIDEO_EXT.has(ext)) return 'video'
  return null
}

/**
 * Resolve a path from an untrusted Workshop `project.json` and keep it inside
 * the item folder. Without this check a malicious item could point `file` at
 * an arbitrary local file and have it served to the renderer.
 */
function itemFile(dir: string, relative: string | undefined): string | undefined {
  if (!relative) return undefined
  const root = path.resolve(dir)
  const resolved = path.resolve(root, relative)
  if (resolved !== root && !resolved.toLowerCase().startsWith(`${root.toLowerCase()}${path.sep}`)) {
    return undefined
  }
  return existsSync(resolved) ? resolved : undefined
}

/**
 * Scan every Steam library for downloaded Wallpaper Engine Workshop items.
 * Items whose project metadata is missing are ignored (Steam deletes the
 * folder while updating, so partial entries are normal and transient).
 *
 * Results are cached briefly: the renderer resolves the wallpaper whenever
 * the config changes, and rescanning thousands of Workshop folders on every
 * render would be wasteful.
 */
let workshopCache: { at: number; items: WorkshopWallpaper[] } | null = null

export function listWorkshopWallpapers(force = false): WorkshopWallpaper[] {
  if (!force && workshopCache && Date.now() - workshopCache.at < 20_000) {
    return workshopCache.items
  }
  const items: WorkshopWallpaper[] = []
  for (const library of wallpaperLibraries()) {
    if (!library.workshopDir) continue
    let entries: string[] = []
    try {
      entries = readdirSync(library.workshopDir)
    } catch {
      continue
    }
    for (const id of entries) {
      if (!/^\d+$/.test(id)) continue
      const dir = path.join(library.workshopDir, id)
      let isDir = false
      try {
        isDir = statSync(dir).isDirectory()
      } catch {
        continue
      }
      if (!isDir) continue
      const project = readProject(dir)
      if (!project) continue
      const previewPath = itemFile(dir, project.preview)
      const sourcePath = itemFile(dir, project.file)
      const kind = classify(sourcePath)
      const playable = kind !== null
      const mediaPath = playable ? sourcePath! : previewPath
      if (!mediaPath) continue
      allow(mediaPath)
      allow(previewPath)
      items.push({
        id,
        title: (project.title || `Workshop ${id}`).trim() || `Workshop ${id}`,
        type: project.type || 'Unknown',
        playable,
        mediaPath,
        previewPath,
        dir
      })
    }
  }
  items.sort((a, b) => a.title.localeCompare(b.title, 'ru'))
  workshopCache = { at: Date.now(), items }
  return items
}

export interface WallpaperPickResult {
  path?: string
  name?: string
}

/** Ask the user for a local image or video to use as wallpaper. */
export async function pickWallpaperFile(): Promise<WallpaperPickResult> {
  const options: Electron.OpenDialogOptions = {
    title: 'Выберите обои',
    properties: ['openFile'],
    filters: [
      { name: 'Изображения и видео', extensions: ['png', 'jpg', 'jpeg', 'webp', 'avif', 'gif', 'bmp', 'mp4', 'webm', 'm4v', 'mov'] },
      { name: 'Изображения', extensions: ['png', 'jpg', 'jpeg', 'webp', 'avif', 'gif', 'bmp'] },
      { name: 'Видео', extensions: ['mp4', 'webm', 'm4v', 'mov'] }
    ]
  }
  const parent = BrowserWindow.getFocusedWindow() ?? BrowserWindow.getAllWindows()[0]
  const result = parent
    ? await dialog.showOpenDialog(parent, options)
    : await dialog.showOpenDialog(options)
  if (result.canceled || !result.filePaths[0]) return {}
  const file = result.filePaths[0]
  if (!allow(file)) return {}
  return { path: file, name: path.basename(file) }
}

function findWorkshopItem(id: string): WorkshopWallpaper | undefined {
  return listWorkshopWallpapers().find((item) => item.id === id)
}

/**
 * Resolve the saved wallpaper config into something the renderer can show.
 * Unknown/missing sources degrade to `kind: 'none'` with an explanatory note
 * instead of throwing — the app must still start if the user deleted the file.
 */
export function resolveWallpaper(config?: WallpaperConfig): WallpaperState {
  const opacity = clamp(config?.opacity, 10, 100, 100)
  const blur = clamp(config?.blur, 0, 32, 0)
  const dim = clamp(config?.dim, 0, 90, 0)
  if (!config?.enabled) {
    return { enabled: false, kind: 'none', opacity, blur, dim }
  }

  if (config.source === 'workshop') {
    const item = config.workshopId ? findWorkshopItem(config.workshopId) : undefined
    if (!item) {
      return {
        enabled: true,
        kind: 'none',
        note: 'Элемент Steam Workshop не найден. Убедитесь, что он скачан в Wallpaper Engine, и нажмите «Обновить список».',
        opacity,
        blur,
        dim
      }
    }
    allow(item.mediaPath)
    allow(item.previewPath)
    const kind = classify(item.mediaPath) ?? 'image'
    return {
      enabled: true,
      kind,
      url: mediaUrl(item.mediaPath),
      previewUrl: item.previewPath ? mediaUrl(item.previewPath) : undefined,
      title: item.title,
      note: item.playable
        ? undefined
        : 'Это сцена Wallpaper Engine — она не может проигрываться без самого Wallpaper Engine, показано превью.',
      opacity,
      blur,
      dim
    }
  }

  if (config.source === 'image' || config.source === 'video') {
    const file = config.path?.trim()
    if (!file || !existsSync(file)) {
      return {
        enabled: true,
        kind: 'none',
        note: 'Файл обоев не найден. Выберите другой файл.',
        opacity,
        blur,
        dim
      }
    }
    const kind = classify(file)
    if (!kind || !allow(file)) {
      return {
        enabled: true,
        kind: 'none',
        note: 'Формат файла не поддерживается. Выберите изображение или видео.',
        opacity,
        blur,
        dim
      }
    }
    return {
      enabled: true,
      kind,
      url: mediaUrl(file),
      title: path.basename(file),
      opacity,
      blur,
      dim
    }
  }

  return { enabled: true, kind: 'none', opacity, blur, dim }
}

export async function openWorkshopItem(id: string): Promise<void> {
  if (!/^\d+$/.test(id)) return
  await shell.openExternal(`https://steamcommunity.com/sharedfiles/filedetails/?id=${id}`)
}
