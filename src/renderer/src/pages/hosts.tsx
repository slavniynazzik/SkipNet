import { useCallback, useEffect, useMemo, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { toast } from 'sonner'
import {
  AlertTriangle,
  CheckCircle2,
  FileText,
  Info,
  Loader2,
  RefreshCw,
  RotateCcw,
  Search,
  ShieldOff
} from 'lucide-react'
import BasePage from '@renderer/components/base/base-page'
import { Card, CardContent, CardHeader, CardTitle } from '@renderer/components/ui/card'
import { Button } from '@renderer/components/ui/button'
import { Input } from '@renderer/components/ui/input'
import { Switch } from '@renderer/components/ui/switch'
import HostsServiceIcon from '@renderer/components/hosts-service-icon'
import { cn } from '@renderer/lib/utils'
import {
  hostsApply,
  hostsDisableAll,
  hostsFlushDns,
  hostsGetOverview,
  hostsImportLegacy,
  hostsOpenFile,
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

function hasAnswers(service: HostsService, profileId: string): boolean {
  return (service.domains ?? []).some((domain) => (domain.answers[profileId]?.length ?? 0) > 0)
}

function defaultProfileFor(
  service: HostsService,
  profiles: HostsDnsProfile[],
  preferred?: string
): string {
  if (service.kind !== 'dns') return 'hosts'
  if (preferred && hasAnswers(service, preferred)) return preferred
  return profiles.find((profile) => hasAnswers(service, profile.id))?.id ?? profiles[0]?.id ?? 'off'
}

function domainCount(service: HostsService): number {
  return service.kind === 'hosts'
    ? (service.entries?.length ?? 0)
    : (service.domains?.length ?? 0)
}

function profileName(profiles: HostsDnsProfile[], id: string): string {
  return profiles.find((profile) => profile.id === id)?.name ?? id
}

const Hosts: React.FC = () => {
  const navigate = useNavigate()
  const [overview, setOverview] = useState<HostsOverview | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [busyService, setBusyService] = useState<string | null>(null)
  const [busyAction, setBusyAction] = useState<string | null>(null)
  const [search, setSearch] = useState('')

  const reload = useCallback(async (): Promise<void> => {
    try {
      setOverview(await hostsGetOverview())
      setError(null)
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setLoading(false)
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
  const controlsLocked = legacyPresent || busyAction !== null

  const accept = (result: HostsOperationResult, success?: string): void => {
    setOverview(result)
    toast.success(success ?? result.message, {
      description: result.warnings.length > 0 ? result.warnings.slice(0, 3).join(' · ') : undefined
    })
  }

  const runAction = async (
    id: string,
    action: () => Promise<HostsOperationResult>
  ): Promise<void> => {
    if (busyAction) return
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

  const setService = async (service: HostsService, value: HostsSelection): Promise<void> => {
    if (busyService || controlsLocked) return
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
  }

  const openFile = (): void => {
    void hostsOpenFile().catch((e: unknown) => {
      toast.error('Не удалось открыть hosts', {
        description: e instanceof Error ? e.message : String(e)
      })
    })
  }

  const flushDns = async (): Promise<void> => {
    if (busyAction) return
    setBusyAction('dns')
    try {
      const result = await hostsFlushDns()
      if (result.ok) toast.success(result.message)
      else toast.warning(result.message)
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
    if (busyAction) return
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
        'Импортировать сервисы из блока ZapretGUI и заменить его блоком SkipNet?\n\n' +
          'Перед изменением будет создан бэкап файла hosts.'
      )
    ) {
      return
    }
    void runAction('import', hostsImportLegacy)
  }

  const query = search.trim().toLowerCase()
  const matches = (service: HostsService): boolean => {
    if (!query) return true
    if (service.name.toLowerCase().includes(query) || service.id.toLowerCase().includes(query)) {
      return true
    }
    const hostnames =
      service.kind === 'hosts'
        ? (service.entries ?? []).map((entry) => entry.hostname)
        : (service.domains ?? []).map((domain) => domain.hostname)
    return hostnames.some((hostname) => hostname.includes(query))
  }

  const enabledCount = status?.enabledServices ?? 0
  const managedLines = status?.managedLines ?? 0
  const catalogVersion = catalog?.meta.version ?? ''
  const checkedAt = catalog?.meta.checkedAt

  const visibleSections = useMemo(() => {
    if (!catalog) return []
    return SECTIONS.map((section) => {
      const all = catalog.services.filter((service) => service.category === section.key)
      return {
        ...section,
        total: all.length,
        enabled: all.filter((service) => isEnabled(state?.selection[service.id])).length,
        services: all.filter(matches)
      }
    })
  }, [catalog, state, query])

  return (
    <BasePage title="Редактор hosts">
      <div className="px-4 pb-6 space-y-4">
        <Card>
          <CardContent className="space-y-4 pt-4">
            <div className="flex flex-wrap items-start justify-between gap-3">
              <div>
                <div className="flex items-baseline gap-3">
                  <span className="text-4xl font-bold text-primary">{enabledCount}</span>
                  <span className="text-sm text-muted-foreground">сервисов включено в hosts</span>
                </div>
                <div className="mt-1 text-[11px] text-muted-foreground">
                  строк в файле: {managedLines}
                  {catalogVersion ? ` · каталог ${catalogVersion}` : ''}
                  {checkedAt ? ` · адреса проверены ${formatWhen(checkedAt)}` : ''}
                </div>
              </div>
              <div className="flex flex-wrap gap-2">
                <Button size="sm" variant="outline" onClick={openFile}>
                  <FileText className="h-3.5 w-3.5" />
                  Файл hosts
                </Button>
                <Button
                  size="sm"
                  variant="outline"
                  onClick={() => { void flushDns() }}
                  disabled={busyAction !== null}
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
                  disabled={busyAction !== null}
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
                disabled={busyAction !== null}
              >
                {busyAction === 'catalog'
                  ? <Loader2 className="h-3.5 w-3.5 animate-spin" />
                  : <RefreshCw className="h-3.5 w-3.5" />}
                Обновить каталог
              </Button>
              <div className="relative ml-auto w-full sm:w-64">
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
                disabled={busyAction !== null}
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
                onClick={() => { void runAction('apply', hostsApply) }}
                disabled={busyAction !== null}
              >
                Перенести и применить
              </Button>
            </CardContent>
          </Card>
        )}

        {status?.externalChange && !legacyPresent && (
          <Card className="border-sky-500/40 bg-sky-500/5">
            <CardContent className="flex flex-wrap items-center justify-between gap-3 pt-4">
              <div className="min-w-0">
                <div className="flex items-center gap-2 text-sm font-medium">
                  <Info className="h-4 w-4 text-sky-400" />
                  Файл hosts изменён вне SkipNet
                </div>
                <div className="mt-0.5 text-[11px] text-muted-foreground">
                  Управляемый блок не совпадает с сохранённым состоянием. Применение настроек
                  перезапишет только блок SkipNet, остальные строки сохранятся.
                </div>
              </div>
              <Button
                size="sm"
                variant="outline"
                onClick={() => { void runAction('apply', hostsApply) }}
                disabled={busyAction !== null}
              >
                Применить настройки
              </Button>
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
                    {section.services.map((service) => {
                      const selection = state?.selection[service.id]
                      const on = isEnabled(selection)
                      const currentProfile =
                        service.kind === 'dns'
                          ? on && typeof selection === 'string' && selection !== 'hosts'
                            ? selection
                            : defaultProfileFor(service, profiles, state?.defaultDnsProfile)
                          : 'hosts'
                      const busy = busyService === service.id
                      const disabled = controlsLocked || busy
                      return (
                        <div
                          key={service.id}
                          className={cn(
                            'flex items-start gap-3 rounded-xl border p-3 transition',
                            on
                              ? 'border-primary/50 bg-primary/5'
                              : 'border-stroke bg-card/40',
                            busy && 'opacity-60'
                          )}
                        >
                          <div className="flex size-9 shrink-0 items-center justify-center rounded-lg bg-muted/60">
                            <HostsServiceIcon service={service} className="size-5" />
                          </div>
                          <div className="min-w-0 flex-1">
                            <div className="flex items-center gap-1.5">
                              <span className="truncate text-sm font-medium">{service.name}</span>
                              {on && (
                                <CheckCircle2 className="size-3.5 shrink-0 text-emerald-400" />
                              )}
                            </div>
                            <div className="text-[11px] text-muted-foreground">
                              {domainCount(service)} доменов
                              {on && service.kind === 'dns'
                                ? ` · ${profileName(profiles, currentProfile)}`
                                : ''}
                            </div>
                            {service.kind === 'dns' ? (
                              <select
                                value={currentProfile}
                                onChange={(event) => {
                                  void setService(service, event.target.value)
                                }}
                                disabled={disabled}
                                title="DNS-профиль"
                                className={cn(
                                  'mt-1 h-7 max-w-full rounded-md border border-stroke bg-card/60 px-1.5 text-[11px] text-muted-foreground',
                                  'outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-stroke'
                                )}
                              >
                                {profiles.map((profile) => (
                                  <option key={profile.id} value={profile.id}>
                                    {profile.name}
                                  </option>
                                ))}
                              </select>
                            ) : (
                              <span className="mt-1 inline-flex rounded bg-muted px-1.5 py-0.5 text-[10px] text-muted-foreground">
                                Напрямую
                              </span>
                            )}
                          </div>
                          <Switch
                            checked={on}
                            disabled={disabled}
                            onCheckedChange={(checked) => {
                              const value: HostsSelection = checked
                                ? service.kind === 'hosts'
                                  ? 'hosts'
                                  : defaultProfileFor(service, profiles, state?.defaultDnsProfile)
                                : 'off'
                              void setService(service, value)
                            }}
                          />
                        </div>
                      )
                    })}
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
                <div className="flex items-center gap-2 text-sm">
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
