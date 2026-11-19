import { useEffect, useRef, useState } from 'react'
import { Loader2, Download, Sparkles, X } from 'lucide-react'
import {
  appCheckUpdate,
  appInstallUpdate,
  appDismissUpdate,
  type AppUpdateInfo
} from '@renderer/utils/ipc'
import { useAppConfig } from '@renderer/hooks/use-app-config'
import { Button } from '@renderer/components/ui/button'

const POLL_INTERVAL_MS = 60 * 60 * 1000 // 1 h

export default function AppUpdateOverlay(): React.ReactElement | null {
  const { appConfig } = useAppConfig()
  const configReady = !!appConfig
  // `autoCheckUpdate` was previously dead config: the overlay always polled
  // GitHub. Respect the toggle and wait for the config to load, so a user who
  // disabled auto-checks never sees a flash of the overlay on startup.
  const autoCheck = appConfig?.autoCheckUpdate !== false
  const [info, setInfo] = useState<AppUpdateInfo | null>(null)
  const [installing, setInstalling] = useState(false)
  const installingRef = useRef(false)
  const [error, setError] = useState<string | null>(null)
  const [closing, setClosing] = useState(false)

  useEffect(() => {
    if (!configReady || !autoCheck) {
      setInfo(null)
      return
    }
    let cancelled = false
    const check = async (force = false): Promise<void> => {
      try {
        const next = await appCheckUpdate(force)
        if (cancelled) return
        setInfo(next)
      } catch {
        /* noop — silent in background */
      }
    }
    check(false)
    const id = window.setInterval(() => check(true), POLL_INTERVAL_MS)
    return () => {
      cancelled = true
      window.clearInterval(id)
    }
  }, [configReady, autoCheck])

  useEffect(() => {
    // Manual check from Settings can surface an update even when automatic
    // checks are disabled: the page dispatches the freshly fetched info.
    const handler = (event: Event): void => {
      const detail = (event as CustomEvent<AppUpdateInfo>).detail
      if (detail) setInfo(detail)
    }
    window.addEventListener('skipnet:app-update-available', handler)
    return () => window.removeEventListener('skipnet:app-update-available', handler)
  }, [])

  useEffect(() => {
    // Re-show the overlay when a *newer* release arrives after the user
    // dismissed the previous one in this session.
    setClosing(false)
  }, [info?.tag])

  const visible =
    !!info &&
    info.hasUpdate &&
    !!info.tag &&
    !info.dismissed &&
    !closing

  const handleInstall = async (): Promise<void> => {
    // Two clicks in the same tick would both see `installing === false` and
    // start two ~100 MB downloads / two installers.
    if (!info?.tag || installingRef.current) return
    installingRef.current = true
    setInstalling(true)
    setError(null)
    try {
      await appInstallUpdate(info.tag)
      // Main process will quit SkipNet within ~1 s. We just keep the
      // spinner up; user perceives "downloading… closing…".
    } catch (e) {
      installingRef.current = false
      setInstalling(false)
      setError(e instanceof Error ? e.message : String(e))
    }
  }

  const handleLater = async (): Promise<void> => {
    if (!info?.tag) {
      setClosing(true)
      return
    }
    setClosing(true)
    try {
      await appDismissUpdate(info.tag)
    } catch {
      /* noop — dismissal is a soft signal */
    }
  }

  if (!visible || !info) return null

  return (
    <div
      className="fixed inset-0 z-[200] flex items-center justify-center"
      style={{
        background: 'rgba(0, 0, 0, 0.55)',
        backdropFilter: 'blur(12px)',
        WebkitBackdropFilter: 'blur(12px)'
      }}
    >
      {/* Card uses the same theme tokens as the rest of the UI: bg-popover
          and text-popover-foreground resolve to white-on-dark in dark mode
          and dark-on-white in light mode automatically via next-themes.
          No hard-coded green / white anywhere — the modal now blends with
          whatever theme the user has picked under Settings. */}
      <div className="relative w-[min(560px,92vw)] rounded-2xl border border-border bg-popover text-popover-foreground shadow-2xl p-6 sm:p-8">
        <button
          type="button"
          onClick={handleLater}
          disabled={installing}
          aria-label="Закрыть"
          className="absolute top-3 right-3 size-8 inline-flex items-center justify-center rounded-md text-muted-foreground hover:text-foreground hover:bg-accent transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
        >
          <X className="size-4" />
        </button>

        <div className="flex items-start gap-4">
          <div className="shrink-0 size-12 rounded-xl bg-accent inline-flex items-center justify-center text-foreground">
            <Sparkles className="size-6" />
          </div>
          <div className="min-w-0 flex-1">
            <div className="text-xl sm:text-2xl font-semibold leading-tight">
              Доступно обновление SkipNet
            </div>
            <div className="mt-1 text-sm text-muted-foreground">
              Текущая версия: <span className="font-mono">v{info.installed}</span>
              {info.latest ? (
                <>
                  {'  →  '}
                  <span className="font-mono font-semibold text-foreground">v{info.latest}</span>
                </>
              ) : null}
            </div>
            {info.releaseNotes ? (
              <div className="mt-4 max-h-44 overflow-y-auto rounded-lg border border-border bg-muted/50 p-3 text-sm whitespace-pre-wrap leading-relaxed">
                {info.releaseNotes}
              </div>
            ) : null}
            {error ? (
              <div className="mt-3 text-sm text-destructive">
                Не удалось установить обновление: {error}
              </div>
            ) : null}
          </div>
        </div>

        <div className="mt-6 flex items-center justify-end gap-2">
          <Button
            variant="ghost"
            onClick={handleLater}
            disabled={installing}
          >
            Позже
          </Button>
          <Button onClick={handleInstall} disabled={installing}>
            {installing ? (
              <>
                <Loader2 className="size-4 mr-2 animate-spin" />
                Загрузка…
              </>
            ) : (
              <>
                <Download className="size-4 mr-2" />
                Установить
              </>
            )}
          </Button>
        </div>

        <div className="mt-3 text-[11px] text-muted-foreground leading-relaxed">
          SkipNet закроется на 5–10 секунд для установки и запустится снова автоматически.
          Все настройки и конфиги сохраняются.
        </div>
      </div>
    </div>
  )
}
