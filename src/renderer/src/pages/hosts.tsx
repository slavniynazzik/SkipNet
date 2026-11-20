import { useCallback, useDeferredValue, useEffect, useMemo, useRef, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { toast } from 'sonner'
import {
  AlertTriangle,
  FileText,
  Globe,
  Info,
  Loader2,
  RefreshCw,
  RotateCcw,
  Search,
  ShieldCheck,
  ShieldOff
} from 'lucide-react'
import BasePage from '@renderer/components/base/base-page'
import { Card, CardContent, CardHeader, CardTitle } from '@renderer/components/ui/card'
import { Button } from '@renderer/components/ui/button'
import { Input } from '@renderer/components/ui/input'
import { Switch } from '@renderer/components/ui/switch'
import HostsServiceCard from '@renderer/components/hosts-service-card'
import { cn } from '@renderer/lib/utils'
import { pluralRu } from '@renderer/lib/plural'
import { matchesService } from '@renderer/lib/hosts-search'
import {
  hostsApply,
  hostsDisableAll,
  hostsFlushDns,
  hostsGetOverview,
  hostsImportLegacy,
  hostsOpenFile,
  hostsRefreshAddresses,
  hostsRestoreLatest,
  hostsSetAdobe,
  hostsSetDnsForAll,
  hostsSetService,
  hostsUpdateCatalog
} from '@renderer/utils/ipc'

const SECTIONS: Array<{
  key: HostsService['category']
  title: string
  hint: string
}> = [
  { key: 'direct', title: 'Напрямую', hint: 'адрес прописывается как есть' },
  { key: 'ai', title: 'ИИ-сервисы', hint: 'закрыты для России, нужен DNS-профиль' },
  { key: 'other', title: 'Остальные сервисы', hint: 'закрыты для России, нужен DNS-профиль' }
]

function isEnabled(selection: HostsSelection | undefined): boolean {
  return !!selection && selection !== 'off'
}

function formatWhen(value?: string): string {
  if (!value) return ''
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return value
  return date.toLocaleString('ru-RU', {
    day: '2-digit',
    month: '2-digit',
    hour: '2-digit',
    minute: '2-digit'
  })
}

const Hosts: React.FC = () => {
  const navigate = useNavigate()
  const [overview, setOverview] = useState<HostsOverview | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [busyService, setBusyService] = useState<string | null>(null)
  const [busyAction, setBusyAction] = useState<string | null>(null)
  const [search, setSearch] = useState('')

  // A slow `hosts:overview` (DoH/probing on the main side) can resolve after
  // the user navigated away; never write that stale snapshot into a dead tree.
  const mountedRef = useRef(true)
  useEffect(() => {
    mountedRef.current = true
    return () => {
      mountedRef.current = false
    }
  }, [])

  const reload = useCallback(async (): Promise<void> => {
    try {
      const next = await hostsGetOverview()
      if (!mountedRef.current) return
      setOverview(next)
      setError(null)
    } catch (e) {
      if (mountedRef.current) setError(e instanceof Error ? e.message : String(e))
    } finally {
      if (mountedRef.current) setLoading(false)
    }
  }, [])

  useEffect(() => {
    void reload()
  }, [reload])

  const catalog = overview?.catalog
  const state = overview?.state
  const status = overview?.status
  const profiles = catalog?.dnsProfiles ?? []
  const legacyPresent = !!status?.legacy.zapretGui
  const legacySkipNet = !!status?.legacy.skipNet
  const uiBusy = busyAction !== null || busyService !== null
  const controlsLocked = legacyPresent || legacySkipNet || uiBusy

  const accept = useCallback((result: HostsOperationResult, success?: string): void => {
    // Mutating RPCs no longer return the catalog (it is ~226 KB and never
    // changes on a toggle). Keep the catalog object we already hold so the
    // memoised cards skip re-rendering, and merge only what changed.
    setOverview((prev) =>
      prev
        ? {
            ...prev,
            state: result.state,
            status: result.status,
            recovery: result.recovery
          }
        : prev
    )
    setError(null)
    toast.success(success ?? result.message, {
      description: result.warnings.length > 0 ? result.warnings.slice(0, 3).join(' · ') : undefined
    })
  }, [])

  // Stable identities for the memoised service cards: a card must not
  // re-render just because `busyService`/`controlsLocked` moved, so the
  // handler reads the latest value from refs instead of closing over state.
  const busyServiceRef = useRef(busyService)
  busyServiceRef.current = busyService
  const controlsLockedRef = useRef(controlsLocked)
  controlsLockedRef.current = controlsLocked

  const runAction = async (
    id: string,
    action: () => Promise<HostsOperationResult>
  ): Promise<void> => {
    if (busyAction || busyService) return
    setBusyAction(id)
    try {
      accept(await action())
    } catch (e) {
      toast.error('Не удалось применить изменения', {
        description: e instanceof Error ? e.message : String(e)
      })
      await reload()
    } finally {
      setBusyAction(null)
    }
  }

  const setService = useCallback(
    async (service: HostsService, value: HostsSelection): Promise<void> => {
      if (busyServiceRef.current || controlsLockedRef.current) return
      setBusyService(service.id)
      try {
        accept(await hostsSetService(service.id, value))
      } catch (e) {
        toast.error('Не удалось изменить сервис', {
          description: e instanceof Error ? e.message : String(e)
        })
        await reload()
      } finally {
        setBusyService(null)
      }
    },
    [accept, reload]
  )

  const openFile = (): void => {
    void hostsOpenFile().catch((e: unknown) => {
      toast.error('Не удалось открыть hosts', {
        description: e instanceof Error ? e.message : String(e)
      })
    })
  }

  const flushDns = async (): Promise<void> => {
    if (busyAction || busyService) return
    setBusyAction('dns')
    try {
      const result = await hostsFlushDns()
      // Newer main builds may attach PWA/runtime diagnostics; surface them
      // next to the manual flush result (automatic flushes stay silent).
      const extra = [result.pwa, result.runtime].filter(Boolean).join(' · ')
      if (result.ok) {
        toast.success(result.message, { description: extra || undefined })
      } else {
        toast.warning(result.message, { description: extra || undefined })
      }
    } catch (e) {
      toast.error('Не удалось сбросить DNS-кэш', {
        description: e instanceof Error ? e.message : String(e)
      })
    } finally {
      setBusyAction(null)
    }
  }

  const restoreBackup = (): void => {
    if (!window.confirm('Восстановить последний бэкап файла hosts?')) return
    void runAction('restore', hostsRestoreLatest)
  }

  const disableAll = (): void => {
    if (!window.confirm('Выключить все сервисы в hosts? Записи SkipNet будут удалены.')) return
    void runAction('disableAll', hostsDisableAll)
  }

  const updateCatalog = async (): Promise<void> => {
    if (busyAction || busyService) return
    setBusyAction('catalog')
    try {
      const result = await hostsUpdateCatalog()
      toast.success(
        result.updated ? `Каталог обновлён до ${result.version}` : `Каталог уже актуален (${result.version})`
      )
      await reload()
    } catch (e) {
      toast.error('Не удалось обновить каталог', {
        description: e instanceof Error ? e.message : String(e)
      })
    } finally {
      setBusyAction(null)
    }
  }

  const importLegacy = (): void => {
    if (
      !window.confirm(
        'Импортировать сервисы из старого блока SkipNet/ZapretGUI и заменить его блоком SkipNet?\n\n' +
          'Перед изменением будет создан бэкап файла hosts.'
      )
    ) {
      return
    }
    void runAction('import', hostsImportLegacy)
  }

  // Typing stays responsive: the expensive filter runs against a deferred
  // value, so the input updates immediately while the grid catches up.
  const deferredQuery = useDeferredValue(search)

  const enabledCount = status?.enabledServices ?? 0
  const managedLines = status?.managedLines ?? 0
  const catalogVersion = catalog?.meta.version ?? ''
  const checkedAt = catalog?.meta.checkedAt
  const skippedCount = state?.skippedIps?.length ?? 0
  const resolvedAt = state?.resolvedAt
  const resolvedHostnames = state?.resolvedIps ? Object.keys(state.resolvedIps).length : 0
  const autoDisabledCount = state?.restoreSelection
    ? Object.keys(state.restoreSelection).length
    : 0
  // C4: the state file was corrupt and was rebuilt from the managed block.
  // `readWarning` is the softer case (file unreadable this time, saved
  // settings are shown) and must stay visible instead of silently reverting.
  const recovery = overview?.recovery ?? status?.recovery
  const readWarning = status?.readWarning

  const visibleSections = useMemo(() => {
    if (!catalog) return []
    return SECTIONS.map((section) => {
      const all = catalog.services.filter((service) => service.category === section.key)
      return {
        ...section,
        total: all.length,
        enabled: all.filter((service) => isEnabled(state?.selection[service.id])).length,
        services: all.filter((service) => matchesService(service, deferredQuery))
      }
    })
  }, [catalog, state, deferredQuery])

  return (
    <BasePage title="Редактор hosts">
      <div className="px-4 pb-6 space-y-4">
        <Card>
          <CardContent className="space-y-4 pt-4">
            <div className="flex flex-wrap items-start justify-between gap-3">
              <div>
                <div className="flex items-baseline gap-3">
                  <span className="text-4xl font-bold text-primary">{enabledCount}</span>
                  <span className="text-sm text-muted-foreground">
                    {pluralRu(enabledCount, ['сервис включён', 'сервиса включены', 'сервисов включены'])} в hosts
                  </span>
                </div>
                <div className="mt-1 text-[11px] text-muted-foreground">
                  строк SkipNet в файле: {managedLines}
                  {catalogVersion ? ` · каталог ${catalogVersion}` : ''}
                  {checkedAt ? ` · каталог обновлён ${formatWhen(checkedAt)}` : ''}
                  {resolvedAt
                    ? ` · живые адреса: ${resolvedHostnames} ${pluralRu(resolvedHostnames, ['домен', 'домена', 'доменов'])} (${formatWhen(resolvedAt)})`
                    : ''}
                  {skippedCount > 0 ? ` · пропущено адресов: ${skippedCount}` : ''}
                </div>
              </div>
              <div className="flex flex-wrap gap-2">
                <Button
                  size="sm"
                  variant="outline"
                  onClick={() => { void runAction('resolve', hostsRefreshAddresses) }}
                  disabled={uiBusy}
                  title="Запросить актуальные адреса через DoH и проверить их TLS-рукопожатием с нужным доменом (обычно 1–2 минуты)"
                >
                  {busyAction === 'resolve'
                    ? <Loader2 className="h-3.5 w-3.5 animate-spin" />
                    : <Globe className="h-3.5 w-3.5" />}
                  Обновить адреса
                </Button>
                <Button
                  size="sm"
                  variant="outline"
                  onClick={() => { void runAction('recheck', () => hostsApply(true)) }}
                  disabled={uiBusy}
                  title="Проверить доступность адресов и переписать hosts без недоступных IP"
                >
                  {busyAction === 'recheck'
                    ? <Loader2 className="h-3.5 w-3.5 animate-spin" />
                    : <ShieldCheck className="h-3.5 w-3.5" />}
                  Проверить адреса
                </Button>
                <Button size="sm" variant="outline" onClick={openFile}>
                  <FileText className="h-3.5 w-3.5" />
                  Файл hosts
                </Button>
                <Button
                  size="sm"
                  variant="outline"
                  onClick={() => { void flushDns() }}
                  disabled={uiBusy}
                >
                  {busyAction === 'dns'
                    ? <Loader2 className="h-3.5 w-3.5 animate-spin" />
                    : <RefreshCw className="h-3.5 w-3.5" />}
                  Сбросить DNS
                </Button>
                <Button
                  size="sm"
                  variant="outline"
                  onClick={restoreBackup}
                  disabled={uiBusy}
                >
                  <RotateCcw className="h-3.5 w-3.5" />
                  Из бэкапа
                </Button>
              </div>
            </div>

            <div className="flex flex-wrap items-center gap-2 border-t border-stroke pt-3">
              <span className="text-xs text-muted-foreground">DNS для всех</span>
              <select
                value={state?.defaultDnsProfile ?? ''}
                onChange={(event) => {
                  void runAction('dnsAll', () => hostsSetDnsForAll(event.target.value))
                }}
                disabled={!state || controlsLocked}
                title="Профиль для всех включённых DNS-сервисов"
                className={cn(
                  'h-8 rounded-md border border-stroke bg-card/60 px-2 text-xs',
                  'outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-stroke'
                )}
              >
                {profiles.map((profile) => (
                  <option key={profile.id} value={profile.id}>
                    {profile.name}
                  </option>
                ))}
              </select>
              <Button
                size="sm"
                variant="outline"
                onClick={disableAll}
                disabled={controlsLocked}
              >
                <ShieldOff className="h-3.5 w-3.5" />
                Выключить все
              </Button>
              <Button
                size="sm"
                variant="ghost"
                onClick={() => { void updateCatalog() }}
                disabled={uiBusy}
              >
                {busyAction === 'catalog'
                  ? <Loader2 className="h-3.5 w-3.5 animate-spin" />
                  : <RefreshCw className="h-3.5 w-3.5" />}
                Обновить каталог
              </Button>
              <div className="relative min-w-[220px] flex-1">
                <Search className="pointer-events-none absolute left-2 top-1/2 size-3.5 -translate-y-1/2 text-muted-foreground" />
                <Input
                  value={search}
                  onChange={(event) => setSearch(event.target.value)}
                  placeholder="Поиск сервиса или домена"
                  className="h-8 pl-7 text-xs"
                />
              </div>
            </div>
          </CardContent>
        </Card>

        {recovery?.recovered && (
          <Card className="border-amber-500/40 bg-amber-500/5">
            <CardContent className="pt-4">
              <div className="flex items-center gap-2 text-sm font-medium">
                <AlertTriangle className="h-4 w-4 text-amber-400" />
                Состояние hosts восстановлено по файлу hosts
              </div>
              <div className="mt-0.5 text-[11px] leading-relaxed text-muted-foreground">
                {recovery.warning ??
                  'Файл hosts-state.json был повреждён. Выбор сервисов восстановлен по управляемому блоку в hosts.'}
                {recovery.corruptPath ? (
                  <>
                    {' '}Повреждённый файл сохранён:{' '}
                    <code className="break-all text-[11px]">{recovery.corruptPath}</code>
                  </>
                ) : null}
              </div>
            </CardContent>
          </Card>
        )}

        {readWarning && (
          <Card className="border-amber-500/40 bg-amber-500/5">
            <CardContent className="pt-4">
              <div className="flex items-center gap-2 text-sm font-medium">
                <AlertTriangle className="h-4 w-4 text-amber-400" />
                Не удалось прочитать файл hosts
              </div>
              <div className="mt-0.5 text-[11px] leading-relaxed text-muted-foreground">
                {readWarning} Показаны сохранённые настройки; файл hosts не изменялся.
              </div>
            </CardContent>
          </Card>
        )}

        {legacyPresent && (
          <Card className="border-amber-500/40 bg-amber-500/5">
            <CardContent className="flex flex-wrap items-center justify-between gap-3 pt-4">
              <div className="min-w-0">
                <div className="flex items-center gap-2 text-sm font-medium">
                  <AlertTriangle className="h-4 w-4 text-amber-400" />
                  Найден блок ZapretGUI
                </div>
                <div className="mt-0.5 text-[11px] text-muted-foreground">
                  Импортируйте его сервисы и замените блок, иначе две программы будут
                  перезаписывать друг друга.
                </div>
              </div>
              <Button
                size="sm"
                onClick={importLegacy}
                disabled={uiBusy}
              >
                {busyAction === 'import' && <Loader2 className="h-3.5 w-3.5 animate-spin" />}
                Импортировать и заменить
              </Button>
            </CardContent>
          </Card>
        )}

        {status?.legacy.skipNet && !legacyPresent && (
          <Card className="border-sky-500/40 bg-sky-500/5">
            <CardContent className="flex flex-wrap items-center justify-between gap-3 pt-4">
              <div className="min-w-0">
                <div className="flex items-center gap-2 text-sm font-medium">
                  <Info className="h-4 w-4 text-sky-400" />
                  Найден старый блок SkipNet
                </div>
                <div className="mt-0.5 text-[11px] text-muted-foreground">
                  Записи Telegram и GitHub будут перенесены в новый редактор, после чего старый
                  блок будет удалён.
                </div>
              </div>
              <Button
                size="sm"
                variant="outline"
                onClick={importLegacy}
                disabled={uiBusy}
              >
                Перенести и применить
              </Button>
            </CardContent>
          </Card>
        )}

        {(status?.externalChange || status?.needsReapply) &&
          !legacyPresent &&
          !status?.legacy.skipNet && (
            <Card className="border-sky-500/40 bg-sky-500/5">
              <CardContent className="flex flex-wrap items-center justify-between gap-3 pt-4">
                <div className="min-w-0">
                  <div className="flex items-center gap-2 text-sm font-medium">
                    <Info className="h-4 w-4 text-sky-400" />
                    {status.needsReapply && !status.externalChange
                      ? 'Каталог обновлён — примените новые адреса'
                      : 'Файл hosts изменён вне SkipNet'}
                  </div>
                  <div className="mt-0.5 text-[11px] text-muted-foreground">
                    {status.needsReapply && !status.externalChange
                      ? 'В каталоге изменились адреса. Нажмите «Применить настройки», чтобы записать их в hosts.'
                      : 'Управляемый блок не совпадает с сохранённым состоянием. Применение настроек перезапишет только блок SkipNet, остальные строки сохранятся.'}
                  </div>
                </div>
                <Button
                  size="sm"
                  variant="outline"
                  onClick={() => { void runAction('apply', hostsApply) }}
                  disabled={uiBusy}
                >
                  Применить настройки
                </Button>
              </CardContent>
            </Card>
          )}

        {(skippedCount > 0 || autoDisabledCount > 0) &&
          !legacyPresent &&
          !status?.legacy.skipNet && (
          <Card className="border-amber-500/40 bg-amber-500/5">
            <CardContent className="flex flex-wrap items-center justify-between gap-3 pt-4">
              <div className="min-w-0">
                <div className="flex items-center gap-2 text-sm font-medium">
                  <Info className="h-4 w-4 text-amber-400" />
                  {skippedCount > 0
                    ? `Пропущено недоступных адресов: ${skippedCount}`
                    : `Автоматически выключено сервисов: ${autoDisabledCount}`}
                </div>
                {autoDisabledCount > 0 && skippedCount > 0 && (
                  <div className="mt-0.5 text-[11px] text-muted-foreground">
                    Автоматически выключено сервисов: {autoDisabledCount}
                  </div>
                )}
                <div className="mt-0.5 text-[11px] text-muted-foreground">
                  Эти IP не отвечают на порту 443 и не записываются в hosts — иначе каждое
                  соединение ждало бы таймаут. Нажмите «Подобрать живые»: SkipNet запросит
                  актуальные адреса через DoH и проверит каждый TLS-рукопожатием
                  (обычно 1–2 минуты).
                </div>
              </div>
              <div className="flex flex-wrap gap-2">
                <Button
                  size="sm"
                  onClick={() => { void runAction('resolve', hostsRefreshAddresses) }}
                  disabled={uiBusy}
                >
                  {busyAction === 'resolve'
                    ? <Loader2 className="h-3.5 w-3.5 animate-spin" />
                    : <Globe className="h-3.5 w-3.5" />}
                  Подобрать живые
                </Button>
                <Button
                  size="sm"
                  variant="outline"
                  onClick={() => { void runAction('recheck', () => hostsApply(true)) }}
                  disabled={uiBusy}
                >
                  Проверить снова
                </Button>
              </div>
            </CardContent>
          </Card>
        )}

        {error && (
          <Card className="border-red-500/40">
            <CardContent className="pt-4">
              <p className="text-sm text-red-400">{error}</p>
              <Button
                size="sm"
                variant="outline"
                className="mt-2"
                onClick={() => { void reload() }}
              >
                Повторить
              </Button>
            </CardContent>
          </Card>
        )}

        {loading ? (
          <div className="flex items-center justify-center py-16">
            <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
          </div>
        ) : (
          visibleSections.map((section) => (
            <Card key={section.key}>
              <CardHeader className="pb-2">
                <CardTitle className="flex flex-wrap items-baseline gap-2 text-base">
                  {section.title}
                  <span className="text-xs font-normal text-muted-foreground">
                    {section.enabled} из {section.total}
                  </span>
                  <span className="text-[11px] font-normal text-muted-foreground">
                    · {section.hint}
                  </span>
                </CardTitle>
              </CardHeader>
              <CardContent>
                {section.services.length === 0 ? (
                  <p className="text-sm text-muted-foreground">Ничего не найдено.</p>
                ) : (
                  <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4">
                    {section.services.map((service) => (
                      <HostsServiceCard
                        key={service.id}
                        service={service}
                        selection={state?.selection[service.id]}
                        profiles={profiles}
                        defaultDnsProfile={state?.defaultDnsProfile}
                        busy={busyService === service.id}
                        disabled={controlsLocked || busyService === service.id}
                        onSetService={setService}
                      />
                    ))}
                  </div>
                )}
              </CardContent>
            </Card>
          ))
        )}

        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-base">Блокировки</CardTitle>
          </CardHeader>
          <CardContent>
            <div className="flex items-center justify-between gap-3">
              <div className="min-w-0">
                <div id="hosts-adobe-block-label" className="flex items-center gap-2 text-sm">
                  <ShieldOff className="h-4 w-4 text-muted-foreground" />
                  Блокировать активацию Adobe
                </div>
                <div className="mt-0.5 text-[11px] text-muted-foreground">
                  {status?.adobeEntries ?? 0} серверов перенаправляются на 127.0.0.1. Выключено
                  по умолчанию.
                </div>
              </div>
              <Switch
                checked={state?.adobeBlock ?? false}
                disabled={controlsLocked || !state}
                aria-labelledby="hosts-adobe-block-label"
                onCheckedChange={(checked) => {
                  void runAction('adobe', () => hostsSetAdobe(checked))
                }}
              />
            </div>
          </CardContent>
        </Card>

        <p className="text-[11px] leading-relaxed text-muted-foreground">
          hosts помогает при DNS-блокировках и подмене DNS. При DPI/SNI-блокировках (YouTube,
          Discord и подобные сервисы) используйте Zapret —{' '}
          <button
            type="button"
            className="text-primary hover:underline"
            onClick={() => navigate('/zapret')}
          >
            перейти на страницу Zapret
          </button>
          . Браузер с включённым Secure DNS может игнорировать hosts.
        </p>
      </div>
    </BasePage>
  )
}

export default Hosts
