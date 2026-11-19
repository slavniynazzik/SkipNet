import { useEffect, useRef, useState } from 'react'
import { Dialog } from 'radix-ui'
import { Loader2, Download, Sparkles, X } from 'lucide-react'
import { appInstallUpdate, type AppUpdateInfo } from '@renderer/utils/ipc'
import { useUpdateCheck } from '@renderer/hooks/use-update-check'
import { Button } from '@renderer/components/ui/button'

const POLL_INTERVAL_MS = 60 * 60 * 1000 // 1 h

export default function AppUpdateOverlay(): React.ReactElement | null {
  // Shared cached check. The `autoCheckUpdate` gate lives in the hook, so a
  // user who disabled automatic checks never sees a flash of the overlay on
  // startup, and the hourly refresh reuses the same SWR entry instead of a
  // second fetch path.
  const appUpdates = useUpdateCheck('app')
  const { info: sharedInfo, enabled, refresh, dismiss } = appUpdates
  // Manual check from Settings can surface an update even when automatic
  // checks are disabled. The page dispatches the freshly fetched info; it is
  // only used while the shared cache has no entry (gate off).
  const [manualInfo, setManualInfo] = useState<AppUpdateInfo | null>(null)
  const info = sharedInfo ?? manualInfo

  const [installing, setInstalling] = useState(false)
  const installingRef = useRef(false)
  const installRef = useRef<HTMLButtonElement>(null)
  const [error, setError] = useState<string | null>(null)
  const [closing, setClosing] = useState(false)
  const [dismissing, setDismissing] = useState(false)

  useEffect(() => {
    if (!enabled) return
    const id = window.setInterval(() => {
      void refresh()
    }, POLL_INTERVAL_MS)
    return () => window.clearInterval(id)
  }, [enabled, refresh])

  useEffect(() => {
    const handler = (event: Event): void => {
      const detail = (event as CustomEvent<AppUpdateInfo>).detail
      if (detail) setManualInfo(detail)
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
    if (dismissing) return
    // The install already started a process that will quit the app; hiding
    // the modal now would only expose a dead window behind it.
    if (installingRef.current) return
    if (!info?.tag) {
      setClosing(true)
      return
    }
    setDismissing(true)
    // The hook awaits `app:dismissUpdate`, toasts on failure and resolves
    // false; only then may the overlay hide (R12). The banner was never
    // optimistically dismissed, so a failed write leaves it on screen.
    const ok = await dismiss(info)
    setDismissing(false)
    if (!ok) return
    setClosing(true)
    if (!sharedInfo) setManualInfo({ ...info, dismissed: true })
  }

  if (!visible || !info) return null

  return (
    // Radix Dialog gives this overlay real dialog semantics for free: focus
    // trap, `role="dialog"`, `aria-modal`, `aria-labelledby` from the title,
    // an inert/aria-hidden background and focus restoration on close.
    <Dialog.Root
      open
      onOpenChange={(next) => {
        // Escape and any programmatic close route through «Позже»; the
        // overlay itself only hides after the awaited dismiss succeeds.
        if (!next) void handleLater()
      }}
    >
      <Dialog.Portal>
        <Dialog.Overlay
          className="fixed inset-0 z-[200]"
          style={{
            background: 'rgba(0, 0, 0, 0.55)',
            backdropFilter: 'blur(12px)',
            WebkitBackdropFilter: 'blur(12px)'
          }}
        />
        <Dialog.Content
          aria-describedby={undefined}
          onEscapeKeyDown={(event) => {
            // Esc must behave exactly like the «Позже» button.
            event.preventDefault()
            void handleLater()
          }}
          onInteractOutside={(event) => event.preventDefault()}
          onOpenAutoFocus={(event) => {
            // Primary action first, not the close «X».
            event.preventDefault()
            installRef.current?.focus()
          }}
          className="fixed left-1/2 top-1/2 z-[200] -translate-x-1/2 -translate-y-1/2 w-[min(560px,92vw)] rounded-2xl border border-border bg-popover text-popover-foreground shadow-2xl p-6 sm:p-8"
        >
          {/* Card uses the same theme tokens as the rest of the UI: bg-popover
              and text-popover-foreground resolve to white-on-dark in dark mode
              and dark-on-white in light mode automatically via next-themes.
              No hard-coded green / white anywhere — the modal now blends with
              whatever theme the user has picked under Settings. */}
          <button
            type="button"
            onClick={() => { void handleLater() }}
            disabled={installing || dismissing}
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
              <Dialog.Title className="text-xl sm:text-2xl font-semibold leading-tight">
                Доступно обновление SkipNet
              </Dialog.Title>
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
              onClick={() => { void handleLater() }}
              disabled={installing || dismissing}
            >
              {dismissing ? 'Сохраняем…' : 'Позже'}
            </Button>
            <Button
              ref={installRef}
              onClick={handleInstall}
              disabled={installing || dismissing}
            >
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
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  )
}
