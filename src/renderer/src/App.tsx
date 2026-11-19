import { useEffect, useState } from 'react'
import { useLocation, useRoutes } from 'react-router-dom'
import { toast } from 'sonner'
import { useTheme } from 'next-themes'
import i18n from './i18n'
import routes from '@renderer/routes'
import { useAppConfig } from '@renderer/hooks/use-app-config'
import { applyTheme, setNativeTheme, wallpaperResolve, type WallpaperState } from '@renderer/utils/ipc'
import { SidebarProvider } from '@renderer/components/ui/sidebar'
import AppSidebar from '@renderer/components/app-sidebar'
import AppUpdateOverlay from '@renderer/components/app-update-overlay'
import WindowControls from '@renderer/components/window-controls'
import { platform } from '@renderer/utils/init'
import { attachLogsStore } from '@renderer/store/logs-store'
import { attachTgwsStore } from '@renderer/store/tgws-store'
import { attachZapretStore } from '@renderer/store/zapret-store'
import { attachZapretTestStore } from '@renderer/store/zapret-test-store'
import mapDark from '@renderer/assets/map_darktheme.svg'
import mapLight from '@renderer/assets/map_lighttheme.svg'

const App: React.FC = () => {
  const { appConfig } = useAppConfig()
  const { appTheme = 'dark', customTheme } = appConfig || {}
  const { setTheme, resolvedTheme } = useTheme()
  const page = useRoutes(routes)
  const location = useLocation()
  const isHome = location.pathname === '/' || location.pathname.includes('/home')
  const mapBg = resolvedTheme === 'dark' ? mapDark : mapLight
  const [wallpaper, setWallpaper] = useState<WallpaperState | null>(null)
  const wallpaperKey = JSON.stringify(appConfig?.wallpaper ?? null)
  const wallpaperActive = !!wallpaper?.enabled && wallpaper.kind !== 'none' && !!wallpaper.url

  useEffect(() => {
    let cancelled = false
    wallpaperResolve()
      .then((state) => {
        if (!cancelled) setWallpaper(state)
      })
      .catch(() => {
        if (!cancelled) setWallpaper(null)
      })
    return () => {
      cancelled = true
    }
  }, [wallpaperKey])

  useEffect(() => {
    const d1 = attachLogsStore()
    const d2 = attachTgwsStore()
    const d3 = attachZapretStore()
    const d4 = attachZapretTestStore()
    return () => {
      d1()
      d2()
      d3()
      d4()
    }
  }, [])

  useEffect(() => {
    void setNativeTheme(appTheme).catch(() => {
      /* visual sync only; the DOM theme from next-themes still applies */
    })
    setTheme(appTheme)
  }, [appTheme, setTheme])

  useEffect(() => {
    applyTheme(customTheme || 'default.css').catch(() => {
      /* noop */
    })
  }, [customTheme])

  // R15: the document language must follow the selected UI language so screen
  // readers and the spell-checker use the right locale. `i18n.language` is
  // already resolved from localStorage/system on module init; the listener
  // keeps it in sync when the user switches language at runtime.
  useEffect(() => {
    const applyLang = (language: string): void => {
      if (language) document.documentElement.lang = language
    }
    applyLang(i18n.language)
    i18n.on('languageChanged', applyLang)
    return () => i18n.off('languageChanged', applyLang)
  }, [])

  useEffect(() => {
    const handleShowError = (...args: unknown[]): void => {
      const [title, message] = args as [string, string]
      toast.error(title, { description: message })
    }
    return window.skipnet.on('showError', handleShowError)
  }, [])

  // Fix the classic Electron "sticky hover/focus" bug.
  useEffect(() => {
    let resetTimer: ReturnType<typeof setTimeout> | null = null

    const clearStuckState = (): void => {
      if (document.activeElement instanceof HTMLElement) {
        document.activeElement.blur()
      }
      const body = document.body
      body.classList.add('hover-reset')
      if (resetTimer) clearTimeout(resetTimer)
      // 120 ms is empirically reliable across 60/120/144 Hz displays. The
      resetTimer = setTimeout(() => body.classList.remove('hover-reset'), 120)
    }

    window.addEventListener('blur', clearStuckState)
    window.addEventListener('focus', clearStuckState)
    const handleVisibilityIpc = (): void => clearStuckState()
    const offVisibility = window.skipnet.on('window:visibility', handleVisibilityIpc)

    return () => {
      window.removeEventListener('blur', clearStuckState)
      window.removeEventListener('focus', clearStuckState)
      offVisibility()
      if (resetTimer) clearTimeout(resetTimer)
    }
  }, [])

  return (
    // Dark = pure black (was #080F16, deep navy). Light = neutral light
    // gray (was #C5D4F1, periwinkle blue) so light mode also drops the
    // blue tint and stays consistent with the new monochrome palette.
    <SidebarProvider
      defaultOpen={false}
      className="relative w-full h-screen overflow-hidden"
      style={{ backgroundColor: resolvedTheme === 'dark' ? '#000000' : '#E5E5E5' }}
    >
      {!wallpaperActive && (
        <img
          src={mapBg}
          alt=""
          className={`pointer-events-none absolute inset-0 opacity-65 w-full h-full object-cover z-0 transition-[filter] duration-500 ${
            isHome ? '' : 'blur-3xl'
          }`}
        />
      )}
      {wallpaperActive && wallpaper && (
        <div
          key={wallpaper.url}
          className="pointer-events-none absolute inset-0 z-0 overflow-hidden"
          style={{ opacity: Math.min(100, Math.max(10, wallpaper.opacity)) / 100 }}
        >
          {wallpaper.kind === 'video' ? (
            <video
              src={wallpaper.url}
              autoPlay
              loop
              muted
              playsInline
              className="h-full w-full object-cover"
              style={{
                filter: wallpaper.blur ? `blur(${wallpaper.blur}px)` : undefined,
                transform: wallpaper.blur ? 'scale(1.06)' : undefined
              }}
            />
          ) : (
            <img
              src={wallpaper.url}
              alt=""
              className="h-full w-full object-cover"
              style={{
                filter: wallpaper.blur ? `blur(${wallpaper.blur}px)` : undefined,
                transform: wallpaper.blur ? 'scale(1.06)' : undefined
              }}
            />
          )}
          {wallpaper.dim > 0 && (
            <div
              className="absolute inset-0 bg-black"
              style={{ opacity: Math.min(90, Math.max(0, wallpaper.dim)) / 100 }}
            />
          )}
        </div>
      )}
      {platform === 'darwin' && (
        <div className="fixed top-0.5 -left-1 h-14.25 flex items-center pl-3 z-100 app-drag">
          <WindowControls />
        </div>
      )}
      <AppSidebar />
      <div className="relative z-10 main grow h-full overflow-y-auto">{page}</div>
      <AppUpdateOverlay />
    </SidebarProvider>
  )
}

export default App
