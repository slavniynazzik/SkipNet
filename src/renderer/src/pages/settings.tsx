import { useEffect, useRef, useState } from 'react'
import { toast } from 'sonner'
import { Loader2, RefreshCw } from 'lucide-react'
import { useAppConfig } from '@renderer/hooks/use-app-config'
import { useUpdateCheck } from '@renderer/hooks/use-update-check'
import { tgwsPatch, zapretPatch } from '@renderer/lib/config-patch'
import { Card, CardContent, CardHeader, CardTitle } from '@renderer/components/ui/card'
import { Label } from '@renderer/components/ui/label'
import { Switch } from '@renderer/components/ui/switch'
import { Button } from '@renderer/components/ui/button'
import { appRelaunch, getAppVersion } from '@renderer/utils/ipc'
import BasePage from '@renderer/components/base/base-page'
import WallpaperCard from '@renderer/components/wallpaper-card'
import {
  BUNDLED_TGWS_VERSION,
  BUNDLED_ZAPRET_VERSION,
  POWER_ON_BANNER_STYLE
} from '@renderer/lib/utils'

const themes: AppTheme[] = ['light', 'dark']
const themeLabels: Record<AppTheme, string> = {
  light: 'Светлая',
  dark: 'Тёмная'
}

const Settings: React.FC = () => {
  const { appConfig, patchAppConfig } = useAppConfig()
  const appUpdates = useUpdateCheck('app')
  const tgwsUpdates = useUpdateCheck('tgws')
  const zapretUpdates = useUpdateCheck('zapret')
  const [checkingUpdates, setCheckingUpdates] = useState(false)
  const checkingRef = useRef(false)
  const [appVersion, setAppVersion] = useState<string | null>(null)

  useEffect(() => {
    let cancelled = false
    getAppVersion()
      .then((value) => {
        if (!cancelled) setAppVersion(value)
      })
      .catch(() => {
        if (!cancelled) setAppVersion(null)
      })
    return () => {
      cancelled = true
    }
  }, [])

  const checkUpdates = async (): Promise<void> => {
    if (checkingRef.current) return
    checkingRef.current = true
    setCheckingUpdates(true)
    try {
      // Manual checks work even when automatic ones are switched off; they
      // force a fresh IPC round-trip and share the result with the banners.
      const [tgws, zapret, app] = await Promise.allSettled([
        tgwsUpdates.check(),
        zapretUpdates.check(),
        appUpdates.check()
      ])
      const ok: string[] = []
      const failed: string[] = []
      if (tgws.status === 'fulfilled') {
        ok.push(
          tgws.value.hasUpdate
            ? `TgWsProxy: доступно v${tgws.value.latest}`
            : `TgWsProxy: v${tgws.value.installed ?? BUNDLED_TGWS_VERSION} — актуально`
        )
      } else {
        failed.push(
          `TgWsProxy: ${tgws.reason instanceof Error ? tgws.reason.message : String(tgws.reason)}`
        )
      }
      if (zapret.status === 'fulfilled') {
        ok.push(
          zapret.value.hasUpdate
            ? `Zapret: доступно v${zapret.value.latest}`
            : `Zapret: v${zapret.value.installed ?? BUNDLED_ZAPRET_VERSION} — актуально`
        )
      } else {
        failed.push(
          `Zapret: ${zapret.reason instanceof Error ? zapret.reason.message : String(zapret.reason)}`
        )
      }
      if (app.status === 'fulfilled') {
        ok.push(
          app.value.hasUpdate
            ? `SkipNet: доступно v${app.value.latest}`
            : `SkipNet: v${app.value.installed} — актуально`
        )
        if (app.value.hasUpdate) {
          window.dispatchEvent(
            new CustomEvent('skipnet:app-update-available', { detail: app.value })
          )
        }
      } else {
        failed.push(
          `SkipNet: ${app.reason instanceof Error ? app.reason.message : String(app.reason)}`
        )
      }
      if (failed.length > 0) {
        toast.error('Проверка обновлений', { description: failed.join(' · ') })
      } else {
        toast.success('Проверка обновлений завершена', {
          description: ok.join(' · '),
          style: POWER_ON_BANNER_STYLE
        })
      }
    } finally {
      checkingRef.current = false
      setCheckingUpdates(false)
    }
  }

  return (
    <BasePage title="Настройки">
      <div className="px-4 pb-6 space-y-4">
      <Card>
        <CardHeader>
          <CardTitle>Внешний вид</CardTitle>
        </CardHeader>
        <CardContent className="space-y-3">
          <div>
            <Label className="text-sm">Тема</Label>
            <div className="flex gap-2 mt-2">
              {themes.map((theme) => (
                <Button
                  key={theme}
                  size="sm"
                  variant={appConfig?.appTheme === theme ? 'default' : 'outline'}
                  onClick={() => { void patchAppConfig({ appTheme: theme }) }}
                >
                  {themeLabels[theme]}
                </Button>
              ))}
            </div>
          </div>
        </CardContent>
      </Card>

      <WallpaperCard />

      <Card>
        <CardHeader>
          <CardTitle>Запуск</CardTitle>
        </CardHeader>
        <CardContent className="space-y-3">
          <div className="flex items-center justify-between">
            <Label htmlFor="settings-auto-launch" className="text-sm">
              Запускать при входе в Windows
            </Label>
            <Switch
              id="settings-auto-launch"
              checked={appConfig?.autoLaunch ?? false}
              onCheckedChange={(v) => { void patchAppConfig({ autoLaunch: v }) }}
            />
          </div>
          <div className="flex items-center justify-between">
            <Label htmlFor="settings-silent-start" className="text-sm">
              Тихий старт (без окна)
            </Label>
            <Switch
              id="settings-silent-start"
              checked={appConfig?.silentStart ?? false}
              onCheckedChange={(v) => { void patchAppConfig({ silentStart: v }) }}
            />
          </div>
          <div className="flex items-center justify-between">
            <Label htmlFor="settings-tgws-autostart" className="text-sm">
              Автозапуск Telegram
            </Label>
            <Switch
              id="settings-tgws-autostart"
              checked={appConfig?.tgws?.autoStart ?? false}
              disabled={!appConfig?.tgws}
              onCheckedChange={(v) => { void patchAppConfig(tgwsPatch({ autoStart: v })) }}
            />
          </div>
          <div className="flex items-center justify-between">
            <Label htmlFor="settings-zapret-autostart" className="text-sm">
              Автозапуск Zapret
            </Label>
            <Switch
              id="settings-zapret-autostart"
              checked={appConfig?.zapret?.autoStart ?? false}
              disabled={!appConfig?.zapret}
              onCheckedChange={(v) => { void patchAppConfig(zapretPatch({ autoStart: v })) }}
            />
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Интерфейс</CardTitle>
        </CardHeader>
        <CardContent className="space-y-3">
          <div className="flex items-center justify-between">
            <div className="flex flex-col">
              <Label htmlFor="settings-tray-icon" className="text-sm">
                Иконка в трее
              </Label>
              <span className="text-xs text-muted-foreground">
                Если выключена — при нажатии на «X» приложение полностью закрывается и
                завершает работу.
              </span>
            </div>
            <Switch
              id="settings-tray-icon"
              checked={!(appConfig?.disableTray ?? false)}
              onCheckedChange={(v) => { void patchAppConfig({ disableTray: !v }) }}
            />
          </div>
          <div className="flex items-center justify-between">
            <div className="flex flex-col">
              <Label htmlFor="settings-taskbar-icon" className="text-sm">
                Убрать иконку с панели задач
              </Label>
              <span className="text-xs text-muted-foreground">
                Не применяется, если иконка в трее выключена: в этом случае «X»
                полностью закрывает приложение.
              </span>
            </div>
            <Switch
              id="settings-taskbar-icon"
              checked={appConfig?.hideTaskbarIcon ?? false}
              onCheckedChange={(v) => { void patchAppConfig({ hideTaskbarIcon: v }) }}
            />
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Обновления</CardTitle>
        </CardHeader>
        <CardContent className="space-y-3">
          <div className="flex items-center justify-between gap-3">
            <div className="flex flex-col">
              <Label htmlFor="settings-auto-update" className="text-sm">
                Проверять обновления автоматически
              </Label>
              <span className="text-xs text-muted-foreground">
                Показывает окно обновления SkipNet, когда выходит новая версия.
              </span>
            </div>
            <Switch
              id="settings-auto-update"
              checked={appConfig?.autoCheckUpdate ?? true}
              onCheckedChange={(v) => { void patchAppConfig({ autoCheckUpdate: v }) }}
            />
          </div>
          <div className="flex items-center justify-between">
            <div className="flex flex-col">
              <Label className="text-sm">SkipNet</Label>
              <span className="text-xs text-muted-foreground">
                Установлено: v{appVersion ?? '…'}
              </span>
            </div>
          </div>
          <div className="flex items-center justify-between">
            <div className="flex flex-col">
              <Label className="text-sm">Telegram WS (TgWsProxy)</Label>
              <span className="text-xs text-muted-foreground">
                Установлено: v{appConfig?.tgws?.installedVersion ?? BUNDLED_TGWS_VERSION}
              </span>
            </div>
          </div>
          <div className="flex items-center justify-between">
            <div className="flex flex-col">
              <Label className="text-sm">Zapret</Label>
              <span className="text-xs text-muted-foreground">
                Установлено: v{appConfig?.zapret?.installedVersion ?? BUNDLED_ZAPRET_VERSION}
              </span>
            </div>
          </div>
          <div className="flex items-center justify-between gap-3">
            <span className="text-xs text-muted-foreground">
              Проверка идёт через GitHub, при блокировке — через резервное зеркало.
            </span>
            <Button
              size="sm"
              variant="outline"
              disabled={checkingUpdates}
              onClick={() => { void checkUpdates() }}
            >
              {checkingUpdates
                ? <Loader2 className="h-3.5 w-3.5 animate-spin" />
                : <RefreshCw className="h-3.5 w-3.5" />}
              Проверить обновления
            </Button>
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Дополнительно</CardTitle>
        </CardHeader>
        <CardContent className="space-y-3">
          <div className="flex items-center justify-between">
            <Label htmlFor="settings-disable-gpu" className="text-sm">
              Отключить аппаратное ускорение (нужен перезапуск)
            </Label>
            <Switch
              id="settings-disable-gpu"
              checked={appConfig?.disableGPU ?? false}
              onCheckedChange={(v) => { void patchAppConfig({ disableGPU: v }) }}
            />
          </div>
          <Button
            size="sm"
            variant="outline"
            onClick={async () => {
              try {
                await appRelaunch()
              } catch (e) {
                toast.error('Не удалось перезапустить приложение', {
                  description: e instanceof Error ? e.message : String(e)
                })
              }
            }}
          >
            Перезапустить приложение
          </Button>
        </CardContent>
      </Card>
      </div>
    </BasePage>
  )
}

export default Settings
