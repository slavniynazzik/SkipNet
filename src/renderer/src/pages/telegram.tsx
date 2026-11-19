import { useEffect, useRef, useState } from 'react'
import { toast } from 'sonner'
import { useTgwsStore } from '@renderer/store/tgws-store'
import {
  tgwsGetLink, tgwsStart, tgwsStop, tgwsRestart,
  writeClipboard, openTelegramLink,
  tgwsInstallUpdate
} from '@renderer/utils/ipc'
import { useAppConfig } from '@renderer/hooks/use-app-config'
import { useUpdateCheck } from '@renderer/hooks/use-update-check'
import { tgwsPatch } from '@renderer/lib/config-patch'
import { updateBannerVisible } from '@renderer/lib/update-check'
import { Button } from '@renderer/components/ui/button'
import { Input } from '@renderer/components/ui/input'
import { Label } from '@renderer/components/ui/label'
import { Card, CardContent, CardHeader, CardTitle } from '@renderer/components/ui/card'
import { Copy, ExternalLink, MoreVertical, Download, Loader2, Sparkles, RefreshCw } from 'lucide-react'
import TelegramIcon from '@renderer/components/telegram-icon'
import ReloadTgwsIcon from '@renderer/components/reload-tgws-icon'
import BasePage from '@renderer/components/base/base-page'
import SwitcherCard from '@renderer/components/switcher-card'
import { cn, POWER_ON_BANNER_STYLE, BUNDLED_TGWS_VERSION } from '@renderer/lib/utils'

// Re-export the shared banner style under the legacy name so the
// existing toast.success({ style: POWER_ON_TOAST_STYLE }) call sites
// don't need touching. Source of truth lives in lib/utils.ts.
const POWER_ON_TOAST_STYLE = POWER_ON_BANNER_STYLE

function generateTgwsSecret(): string {
  const bytes = new Uint8Array(16)
  crypto.getRandomValues(bytes)
  return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('')
}

const TelegramPage: React.FC = () => {
  const status = useTgwsStore((s) => s.status)
  const { appConfig, patchAppConfig } = useAppConfig()
  const [link, setLink] = useState('')
  const [portDraft, setPortDraft] = useState('')
  const [hostDraft, setHostDraft] = useState('')
  const [secretDraft, setSecretDraft] = useState('')
  const tgws = appConfig?.tgws

  // Keep local text drafts for every editable field. Writing the config on
  // each keystroke makes SWR revalidate concurrently with typing, so a stale
  // response can reset the input and drop characters. Drafts are committed on
  // blur / Enter instead. Port additionally needs a draft so it can be
  // cleared while retyping.
  useEffect(() => {
    setPortDraft(String(tgws?.port ?? 1443))
  }, [tgws?.port])
  useEffect(() => {
    setHostDraft(tgws?.host ?? '')
  }, [tgws?.host])
  useEffect(() => {
    setSecretDraft(tgws?.secret ?? '')
  }, [tgws?.secret])

  // A failed patch is reported once by `patchAppConfig`; the draft snaps back
  // to the persisted value so the input never shows an unsaved setting.
  const commitPort = async (): Promise<void> => {
    const parsed = Number(portDraft)
    if (!Number.isInteger(parsed) || parsed < 1 || parsed > 65535) {
      setPortDraft(String(tgws?.port ?? 1443))
      return
    }
    setPortDraft(String(parsed))
    if (parsed !== (tgws?.port ?? 1443)) {
      const ok = await patchAppConfig(tgwsPatch({ port: parsed }))
      if (!ok) setPortDraft(String(tgws?.port ?? 1443))
    }
  }

  const commitHost = async (): Promise<void> => {
    const value = hostDraft.trim()
    if (!value) {
      setHostDraft(tgws?.host ?? '')
      return
    }
    setHostDraft(value)
    if (value !== (tgws?.host ?? '')) {
      const ok = await patchAppConfig(tgwsPatch({ host: value }))
      if (!ok) setHostDraft(tgws?.host ?? '')
    }
  }

  const commitSecret = async (): Promise<void> => {
    const value = secretDraft.trim()
    if (!/^[0-9a-fA-F]{32}$/.test(value)) {
      // The main process regenerates anything that is not 32 hex chars on
      // start, which would silently change the user's link. Reject it here.
      toast.error('Некорректный секретный ключ', {
        description: 'Нужно ровно 32 hex-символа (0–9, a–f).'
      })
      setSecretDraft(tgws?.secret ?? '')
      return
    }
    setSecretDraft(value)
    if (value !== (tgws?.secret ?? '')) {
      const ok = await patchAppConfig(tgwsPatch({ secret: value }))
      if (!ok) setSecretDraft(tgws?.secret ?? '')
    }
  }

  // The guard matters after "сменить ключ": the pre-rotation request resolves
  // later with the old link and used to overwrite the freshly generated one.
  useEffect(() => {
    let cancelled = false
    tgwsGetLink()
      .then((value) => {
        if (!cancelled) setLink(value)
      })
      .catch(() => {
        if (!cancelled) setLink('')
      })
    return () => {
      cancelled = true
    }
  }, [tgws?.host, tgws?.port, tgws?.secret, status.state])

  const running = status.state === 'running'
  // The updater stops the proxy when it is running OR starting; remember both
  // so an install during startup does not leave it switched off afterwards.
  const restartAfterMutation = running || status.state === 'starting'

  // ---- Auto-update banner (shared, cached across pages)
  const updateCheck = useUpdateCheck('tgws')
  const updateInfo = updateCheck.info
  const showBanner = updateBannerVisible(updateInfo)
  const installingRef = useRef(false)
  const [installing, setInstalling] = useState(false)

  const installUpdate = async (): Promise<void> => {
    if (installingRef.current || !updateInfo?.tag) return
    installingRef.current = true
    setInstalling(true)
    const tId = toast.loading('Скачиваем TgWsProxy…', {
      description: updateInfo.assetName ?? `v${updateInfo.latest}`
    })
    try {
      const res = await tgwsInstallUpdate(updateInfo.tag)
      const mb = (res.sizeBytes / (1024 * 1024)).toFixed(1)
      toast.success('TgWsProxy обновлён', {
        id: tId,
        description: `Версия ${res.installedVersion ?? updateInfo.latest} — ${mb} МБ`,
        // Same vivid power-on green as the other success toasts (copy-link,
        // regenerate-key, processes-reloaded) and the active home-page
        // power-on disc, so success feedback across the app is one colour.
        style: POWER_ON_TOAST_STYLE
      })
      // Re-check so the banner disappears immediately. A failed re-check must
      // not turn a successful install into an error toast.
      try {
        await updateCheck.check()
      } catch {
        /* banner refreshes on the next automatic check */
      }
      // If the proxy was running we already stopped it server-side to free
      // the .exe write lock; restart it so the user doesn't have to.
      if (restartAfterMutation) {
        try { await tgwsStart() } catch { /* user can retry from the toggle */ }
      }
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e)
      toast.error('Не удалось обновить TgWsProxy', { id: tId, description: msg })
    } finally {
      setInstalling(false)
      installingRef.current = false
    }
  }

  // The hook only hides the banner after main persisted the dismissal and
  // shows its own error toast when the write fails (R12).
  const dismissUpdate = (): void => {
    void updateCheck.dismiss()
  }

  // Manual "check now" — the automatic check stays silent on network errors,
  // so users need an explicit action that reports what happened.
  const checkNow = async (): Promise<void> => {
    try {
      const fresh = await updateCheck.check()
      if (fresh.hasUpdate && fresh.tag) {
        toast.info(`Доступно обновление TgWsProxy v${fresh.latest}`, {
          description: 'Нажмите «Обновить» в баннере выше.'
        })
      } else {
        toast.success('У вас последняя версия TgWsProxy', {
          description: `v${fresh.installed ?? BUNDLED_TGWS_VERSION}`,
          style: POWER_ON_TOAST_STYLE
        })
      }
    } catch (e) {
      toast.error('Не удалось проверить обновления', {
        description: e instanceof Error ? e.message : String(e)
      })
    }
  }

  const regeneratingRef = useRef(false)
  const [regenerating, setRegenerating] = useState(false)
  const handleRegenerateLink = async (): Promise<void> => {
    if (regeneratingRef.current || !tgws) return
    regeneratingRef.current = true
    setRegenerating(true)
    try {
      const newSecret = generateTgwsSecret()
      const ok = await patchAppConfig(tgwsPatch({ secret: newSecret }))
      if (!ok) return
      try {
        const updated = await tgwsGetLink()
        setLink(updated)
      } catch {
        setLink('')
      }
      if (restartAfterMutation) {
        try {
          await tgwsRestart()
        } catch (e) {
          // The key is already persisted; the proxy still runs with the old
          // one until the user restarts it, so don't claim full success.
          toast.error('Ключ изменён, но прокси не перезапустился', {
            description: e instanceof Error ? e.message : String(e)
          })
          return
        }
      }
      toast.success('Ключ и ссылка изменены', { style: POWER_ON_TOAST_STYLE })
    } finally {
      setRegenerating(false)
      regeneratingRef.current = false
    }
  }

  return (
    <BasePage title="Telegram">
      <div className="px-4 pb-6 space-y-4">
        {showBanner && updateInfo && (
          <div className={cn(
            'relative flex items-center gap-3 rounded-lg border border-stroke bg-card/70 backdrop-blur-xl px-4 py-3 transition',
            installing && 'pointer-events-none opacity-80'
          )}>
            <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-md bg-primary/15 text-primary">
              {installing
                ? <Loader2 className="h-4 w-4 animate-spin" />
                : <Sparkles className="h-4 w-4" />}
            </div>
            <div className="min-w-0 flex-1">
              <div className="text-sm font-medium text-foreground">
                {installing
                  ? 'Устанавливаем TgWsProxy…'
                  : `Доступно обновление TgWsProxy — v${updateInfo.latest}`}
              </div>
              <div className="text-xs text-muted-foreground truncate">
                {installing
                  ? 'Останавливаем прокси, перезаписываем бинарник…'
                  : `Текущая версия: v${updateInfo.installed ?? '?'}`}
              </div>
            </div>
            {!installing && (
              <div className="flex shrink-0 items-center gap-2">
                <Button variant="ghost" size="sm" onClick={dismissUpdate}>
                  Позже
                </Button>
                <Button size="sm" onClick={() => { void installUpdate() }}>
                  <Download className="h-3.5 w-3.5" />
                  Обновить
                </Button>
              </div>
            )}
          </div>
        )}

        <SwitcherCard
          icon={TelegramIcon}
          title="Telegram"
          subtitle={`${tgws?.host ?? '127.0.0.1'}:${tgws?.port ?? 1443}`}
          version={tgws?.installedVersion ?? updateInfo?.installed ?? BUNDLED_TGWS_VERSION}
          status={status}
          disabled={installing}
          onToggle={(v) => (v ? tgwsStart() : tgwsStop())}
          footer={installing ? 'Устанавливаем обновление…' : running ? null : 'Нажмите для запуска'}
        />

        <div className="flex items-center justify-between gap-3 rounded-lg border border-stroke bg-card/40 px-4 py-2">
          <div className="flex min-w-0 flex-col">
            <span className="text-sm">Обновления TgWsProxy</span>
            <span className="text-xs text-muted-foreground truncate">
              v{tgws?.installedVersion ?? updateInfo?.installed ?? BUNDLED_TGWS_VERSION} ·
              проверка через GitHub (с резервным зеркалом)
            </span>
          </div>
          <Button
            variant="ghost"
            size="sm"
            disabled={updateCheck.checking}
            onClick={() => { void checkNow() }}
          >
            {updateCheck.checking
              ? <Loader2 className="h-3.5 w-3.5 animate-spin" />
              : <RefreshCw className="h-3.5 w-3.5" />}
            Проверить
          </Button>
        </div>

      <Card>
        <CardHeader>
          <CardTitle>Подключение</CardTitle>
        </CardHeader>
        <CardContent className="space-y-3">
          <div className="flex items-center gap-2">
            <Input readOnly value={link} className="font-mono text-xs" />
            <Button
              size="icon-sm"
              variant="outline"
              onClick={async () => {
                if (!link) return
                try {
                  await writeClipboard(link)
                  toast.success('Ссылка скопирована', { style: POWER_ON_TOAST_STYLE })
                } catch (e) {
                  toast.error('Не удалось скопировать ссылку', {
                    description: e instanceof Error ? e.message : String(e)
                  })
                }
              }}
              title="Копировать ссылку"
            >
              <Copy className="size-4" />
            </Button>
            <Button
              size="icon-sm"
              variant="outline"
              onClick={() => {
                if (!link) return
                void openTelegramLink(link).catch((e: unknown) => {
                  toast.error('Не удалось открыть Telegram', {
                    description: e instanceof Error ? e.message : String(e)
                  })
                })
              }}
              title="Открыть в Telegram"
            >
              <ExternalLink className="size-4" />
            </Button>
            <Button
              size="icon-sm"
              variant="outline"
              onClick={handleRegenerateLink}
              disabled={regenerating}
              title="Сменить ключ и ссылку"
            >
              {regenerating
                ? <Loader2 className="size-4 animate-spin" />
                : <ReloadTgwsIcon className="size-4" />}
            </Button>
          </div>
          <p className="text-xs text-muted-foreground inline-flex flex-wrap items-center gap-x-1 gap-y-0.5">
            Вставьте ссылку в Telegram
            <span className="opacity-70">&rarr;</span>
            Настройки
            <span className="opacity-70">&rarr;</span>
            Продвинутые настройки
            <span className="opacity-70">&rarr;</span>
            Тип соединения
            <span className="opacity-70">&rarr;</span>
            <MoreVertical className="size-3.5 translate-y-px -mx-1.5" />
            <span>или нажмите на</span>
            <ExternalLink className="size-3.5 translate-y-px" />
            <span>для автоматического подключения.</span>
          </p>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Параметры</CardTitle>
        </CardHeader>
        <CardContent className="grid grid-cols-1 md:grid-cols-2 gap-x-3 gap-y-4">
          <div className="space-y-1.5">
            <Label>Хост</Label>
            <Input
              value={hostDraft}
              onChange={(e) => setHostDraft(e.target.value)}
              onBlur={() => { void commitHost() }}
              onKeyDown={(e) => {
                if (e.key === 'Enter') e.currentTarget.blur()
              }}
              placeholder="127.0.0.1"
            />
          </div>
          <div className="space-y-1.5">
            <Label>Порт</Label>
            <Input
              type="number"
              value={portDraft}
              onChange={(e) => setPortDraft(e.target.value)}
              onBlur={() => { void commitPort() }}
              onKeyDown={(e) => {
                if (e.key === 'Enter') e.currentTarget.blur()
              }}
              min={1}
              max={65535}
            />
          </div>
          <div className="md:col-span-2 space-y-1.5">
            <Label>Секретный ключ (32-hex MTProto)</Label>
            <Input
              value={secretDraft}
              onChange={(e) => setSecretDraft(e.target.value)}
              onBlur={() => { void commitSecret() }}
              onKeyDown={(e) => {
                if (e.key === 'Enter') e.currentTarget.blur()
              }}
              spellCheck={false}
              className="font-mono text-xs"
            />
          </div>
        </CardContent>
      </Card>

      {status.lastError && (
        <Card className="border-red-500/50">
          <CardContent className="pt-4">
            <p className="text-sm text-red-500">{status.lastError}</p>
          </CardContent>
        </Card>
      )}
      </div>
    </BasePage>
  )
}

export default TelegramPage
