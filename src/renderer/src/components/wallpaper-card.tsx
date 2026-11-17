import { useEffect, useState } from 'react'
import { toast } from 'sonner'
import { FolderOpen, Image, Layers, Loader2, RefreshCw, Video } from 'lucide-react'
import { Card, CardContent, CardHeader, CardTitle } from '@renderer/components/ui/card'
import { Button } from '@renderer/components/ui/button'
import { Switch } from '@renderer/components/ui/switch'
import { useAppConfig } from '@renderer/hooks/use-app-config'
import { cn } from '@renderer/lib/utils'
import {
  wallpaperListWorkshop,
  wallpaperOpenWorkshop,
  wallpaperPick,
  wallpaperResolve,
  type WallpaperState,
  type WorkshopWallpaper
} from '@renderer/utils/ipc'

const DEFAULTS: WallpaperConfig = {
  enabled: false,
  source: 'image',
  opacity: 100,
  blur: 0,
  dim: 0
}

const SOURCES: Array<{ value: WallpaperConfig['source']; label: string; icon: typeof Image }> = [
  { value: 'image', label: 'Изображение', icon: Image },
  { value: 'video', label: 'Видео', icon: Video },
  { value: 'workshop', label: 'Steam Workshop', icon: Layers }
]

const WallpaperCard: React.FC = () => {
  const { appConfig, patchAppConfig } = useAppConfig()
  const wallpaper = appConfig?.wallpaper ?? DEFAULTS
  const [resolved, setResolved] = useState<WallpaperState | null>(null)
  const [workshop, setWorkshop] = useState<WorkshopWallpaper[] | null>(null)
  const [listBusy, setListBusy] = useState(false)
  const [pickBusy, setPickBusy] = useState(false)

  // Ask the main process how the saved config actually resolves (missing
  // files, uninstalled Workshop items, scene fallbacks, ...).
  const configKey = JSON.stringify(wallpaper)
  useEffect(() => {
    let cancelled = false
    wallpaperResolve()
      .then((state) => {
        if (!cancelled) setResolved(state)
      })
      .catch(() => {
        if (!cancelled) setResolved(null)
      })
    return () => {
      cancelled = true
    }
  }, [configKey])

  const patch = (next: Partial<WallpaperConfig>): void => {
    void patchAppConfig({ wallpaper: { ...wallpaper, ...next } })
  }

  const loadWorkshop = async (): Promise<void> => {
    if (listBusy) return
    setListBusy(true)
    const tId = toast.loading('Ищем обои в Steam Workshop…')
    try {
      const items = await wallpaperListWorkshop()
      setWorkshop(items)
      if (items.length === 0) {
        toast.warning('Обои Workshop не найдены', {
          id: tId,
          description:
            'Скачайте обои в Wallpaper Engine (Steam Workshop), затем нажмите «Обновить список».'
        })
      } else {
        toast.success(`Найдено обоев: ${items.length}`, { id: tId })
      }
    } catch (e) {
      toast.error('Не удалось прочитать Steam Workshop', {
        id: tId,
        description: e instanceof Error ? e.message : String(e)
      })
    } finally {
      setListBusy(false)
    }
  }

  const chooseFile = async (source: 'image' | 'video'): Promise<void> => {
    if (pickBusy) return
    setPickBusy(true)
    try {
      const result = await wallpaperPick()
      if (!result.path) return
      patch({ enabled: true, source, path: result.path })
      toast.success('Обои выбраны', { description: result.name })
    } catch (e) {
      toast.error('Не удалось выбрать файл', {
        description: e instanceof Error ? e.message : String(e)
      })
    } finally {
      setPickBusy(false)
    }
  }

  const effectiveSource = wallpaper.source
  const selectedItem = workshop?.find((item) => item.id === wallpaper.workshopId)

  return (
    <Card>
      <CardHeader>
        <CardTitle>Обои</CardTitle>
      </CardHeader>
      <CardContent className="space-y-4">
        <div className="flex items-center justify-between gap-3">
          <div className="flex flex-col">
            <span className="text-sm">Свои обои</span>
            <span className="text-xs text-muted-foreground">
              Заменяют фоновую карту. Видео проигрывается без звука в цикле.
            </span>
          </div>
          <Switch
            checked={wallpaper.enabled}
            onCheckedChange={(enabled) => patch({ enabled })}
          />
        </div>

        {wallpaper.enabled && (
          <>
            <div className="flex flex-wrap gap-2">
              {SOURCES.map(({ value, label, icon: Icon }) => (
                <Button
                  key={value}
                  size="sm"
                  variant={effectiveSource === value ? 'default' : 'outline'}
                  onClick={() => {
                    patch({ source: value })
                    if (value === 'workshop' && workshop === null) void loadWorkshop()
                  }}
                >
                  <Icon className="h-3.5 w-3.5" />
                  {label}
                </Button>
              ))}
            </div>

            {(effectiveSource === 'image' || effectiveSource === 'video') && (
              <div className="rounded-lg border border-stroke bg-muted/20 p-3">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <div className="min-w-0">
                    <div className="text-sm">Файл обоев</div>
                    <div className="mt-0.5 truncate text-[11px] text-muted-foreground">
                      {wallpaper.path
                        ? wallpaper.path
                        : 'Файл не выбран — откроется проводник Windows.'}
                    </div>
                  </div>
                  <Button
                    size="sm"
                    variant="outline"
                    disabled={pickBusy}
                    onClick={() => { void chooseFile(effectiveSource) }}
                  >
                    {pickBusy
                      ? <Loader2 className="h-3.5 w-3.5 animate-spin" />
                      : <FolderOpen className="h-3.5 w-3.5" />}
                    Выбрать файл
                  </Button>
                </div>
              </div>
            )}

            {effectiveSource === 'workshop' && (
              <div className="space-y-2 rounded-lg border border-stroke bg-muted/20 p-3">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <div className="min-w-0">
                    <div className="text-sm">Обои из Steam Workshop</div>
                    <div className="mt-0.5 text-[11px] text-muted-foreground">
                      Список берётся из скачанных элементов Wallpaper Engine.
                    </div>
                  </div>
                  <Button
                    size="sm"
                    variant="outline"
                    disabled={listBusy}
                    onClick={() => { void loadWorkshop() }}
                  >
                    {listBusy
                      ? <Loader2 className="h-3.5 w-3.5 animate-spin" />
                      : <RefreshCw className="h-3.5 w-3.5" />}
                    Обновить список
                  </Button>
                </div>

                <select
                  value={wallpaper.workshopId ?? ''}
                  onChange={(e) => patch({ workshopId: e.target.value || undefined })}
                  className={cn(
                    'h-9 w-full rounded-xl border border-stroke bg-card/50 px-3 text-sm',
                    'outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-stroke'
                  )}
                >
                  <option value="">
                    {workshop === null ? 'Нажмите «Обновить список»' : 'Выберите обои'}
                  </option>
                  {(workshop ?? []).map((item) => (
                    <option key={item.id} value={item.id}>
                      {item.title} — {item.type}
                      {item.playable ? '' : ' (превью)'}
                    </option>
                  ))}
                </select>

                {selectedItem && (
                  <button
                    type="button"
                    className="text-[11px] text-primary hover:underline"
                    onClick={() => { void wallpaperOpenWorkshop(selectedItem.id) }}
                  >
                    Открыть страницу элемента в Steam
                  </button>
                )}
                <p className="text-[11px] text-muted-foreground">
                  Сцены Wallpaper Engine (`.pkg`) не воспроизводятся без самого Wallpaper Engine —
                  для них показывается превью. Видео и изображения работают напрямую.
                </p>
              </div>
            )}

            <div className="grid gap-3 sm:grid-cols-3">
              <RangeField
                label="Прозрачность"
                value={wallpaper.opacity ?? 100}
                min={10}
                max={100}
                suffix="%"
                onChange={(value) => patch({ opacity: value })}
              />
              <RangeField
                label="Размытие"
                value={wallpaper.blur ?? 0}
                min={0}
                max={32}
                suffix=" px"
                onChange={(value) => patch({ blur: value })}
              />
              <RangeField
                label="Затемнение"
                value={wallpaper.dim ?? 0}
                min={0}
                max={90}
                suffix="%"
                onChange={(value) => patch({ dim: value })}
              />
            </div>

            {resolved?.note && (
              <p className="text-[11px] text-amber-400">{resolved.note}</p>
            )}
            {resolved?.title && (
              <p className="text-[11px] text-muted-foreground">Сейчас: {resolved.title}</p>
            )}
          </>
        )}
      </CardContent>
    </Card>
  )
}

const RangeField: React.FC<{
  label: string
  value: number
  min: number
  max: number
  suffix: string
  onChange: (value: number) => void
}> = ({ label, value, min, max, suffix, onChange }) => (
  <label className="block">
    <span className="mb-1 flex items-center justify-between text-[11px] text-muted-foreground">
      <span>{label}</span>
      <span className="font-mono">
        {value}
        {suffix}
      </span>
    </span>
    <input
      type="range"
      min={min}
      max={max}
      value={value}
      onChange={(e) => onChange(Number(e.target.value))}
      className="h-1.5 w-full cursor-pointer appearance-none rounded-full bg-muted accent-primary"
    />
  </label>
)

export default WallpaperCard
