import { Download, Loader2, Sparkles } from 'lucide-react'
import { Button } from '@renderer/components/ui/button'
import { cn } from '@renderer/lib/utils'

export type UpdateBannerKind = 'zapret' | 'tgws'

interface UpdateBannerProps {
  kind: UpdateBannerKind
  /** The shared `useUpdateCheck` result for this component. */
  info: { latest?: string; installed?: string }
  /** True while the install IPC call is in flight. */
  installing: boolean
  onInstall: () => void
  /** Persist the dismissal; the banner hides only after main confirms it. */
  onDismiss: () => void
}

const COPY = {
  zapret: {
    name: 'Zapret',
    installingTitle: 'Устанавливаем Zapret…',
    installingSubtitle: 'Останавливаем winws.exe, распаковываем архив…'
  },
  tgws: {
    name: 'TgWsProxy',
    installingTitle: 'Устанавливаем TgWsProxy…',
    installingSubtitle: 'Останавливаем прокси, перезаписываем бинарник…'
  }
} as const

/**
 * Install banner shared by the Telegram and Zapret pages. The markup, icon
 * swap and "later / install" actions were byte-identical copies before Q3.
 * Home keeps its own details-only notice because it navigates instead of
 * installing.
 */
const UpdateBanner: React.FC<UpdateBannerProps> = ({
  kind,
  info,
  installing,
  onInstall,
  onDismiss
}) => {
  const copy = COPY[kind]
  return (
    <div
      className={cn(
        'relative flex items-center gap-3 rounded-lg border border-stroke bg-card/70 backdrop-blur-xl px-4 py-3 transition',
        installing && 'pointer-events-none opacity-80'
      )}
    >
      <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-md bg-primary/15 text-primary">
        {installing ? (
          <Loader2 className="h-4 w-4 animate-spin" />
        ) : (
          <Sparkles className="h-4 w-4" />
        )}
      </div>
      <div className="min-w-0 flex-1">
        <div className="text-sm font-medium text-foreground">
          {installing
            ? copy.installingTitle
            : `Доступно обновление ${copy.name} — v${info.latest}`}
        </div>
        <div className="text-xs text-muted-foreground truncate">
          {installing
            ? copy.installingSubtitle
            : `Текущая версия: v${info.installed ?? '?'}`}
        </div>
      </div>
      {!installing && (
        <div className="flex shrink-0 items-center gap-2">
          <Button variant="ghost" size="sm" onClick={onDismiss}>
            Позже
          </Button>
          <Button size="sm" onClick={onInstall}>
            <Download className="h-3.5 w-3.5" />
            Обновить
          </Button>
        </div>
      )}
    </div>
  )
}

export default UpdateBanner
