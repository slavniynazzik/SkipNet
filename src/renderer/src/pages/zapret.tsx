import { useCallback, useEffect, useRef, useState } from 'react'
import { useLocation, useNavigate } from 'react-router-dom'
import { toast } from 'sonner'
import {
  Loader2,
  FlaskConical,
  CheckCircle2,
  XCircle,
  RefreshCw,
  ChevronDown
} from 'lucide-react'
import { useZapretStore } from '@renderer/store/zapret-store'
import { useZapretTestStore } from '@renderer/store/zapret-test-store'
import {
  zapretListStrategies,
  zapretStart,
  zapretStop,
  zapretInstallUpdate,
  zapretRunStrategyTest,
  zapretCancelStrategyTest
} from '@renderer/utils/ipc'
import { useAppConfig } from '@renderer/hooks/use-app-config'
import { useUpdateCheck } from '@renderer/hooks/use-update-check'
import { zapretPatch } from '@renderer/lib/config-patch'
import { updateBannerVisible } from '@renderer/lib/update-check'
import { Card, CardContent, CardHeader, CardTitle } from '@renderer/components/ui/card'
import { Button } from '@renderer/components/ui/button'
import ZapretIcon from '@renderer/components/zapret-icon'
import { cn, BUNDLED_ZAPRET_VERSION, POWER_ON_BANNER_STYLE, POWER_OFF_BANNER_STYLE } from '@renderer/lib/utils'
import BasePage from '@renderer/components/base/base-page'
import SwitcherCard from '@renderer/components/switcher-card'
import UpdateBanner from '@renderer/components/update-banner'
import ZapretIpListCard from '@renderer/components/zapret-iplist-card'
import ZapretNetworkCard from '@renderer/components/zapret-network-card'
import ZapretMaintenanceCard from '@renderer/components/zapret-maintenance-card'
import ZapretFakesCard from '@renderer/components/zapret-fakes-card'

const Zapret: React.FC = () => {
  const status = useZapretStore((s) => s.status)
  const { appConfig, patchAppConfig } = useAppConfig()
  const [strategies, setStrategies] = useState<{ file: string; title: string; description: string }[]>([])
  const [bundleRefreshKey, setBundleRefreshKey] = useState(0)
  const zapret = appConfig?.zapret
  const active = zapret?.activeStrategy
  const location = useLocation()
  const navigate = useNavigate()
  const autoStartRef = useRef<boolean>(
    Boolean((location.state as { autoStart?: boolean } | null)?.autoStart)
  )

  // ---- Auto-update banner (shared, cached across pages)
  const updateCheck = useUpdateCheck('zapret')
  const updateInfo = updateCheck.info
  const installingRef = useRef(false)
  const [installing, setInstalling] = useState(false)

  // ---- Strategy test
  const testProgress = useZapretTestStore((s) => s.progress)
  const storedReport = useZapretTestStore((s) => s.report)
  const isTestRunning = useZapretTestStore((s) => s.isRunning)
  // A report produced for an older bundle keys results by `.bat` name, which
  // may now point at a completely different strategy. Ignore it until the new
  // bundle is tested, otherwise freshly-installed strategies stay disabled.
  const reportIsStale =
    !!storedReport?.bundleVersion &&
    !!zapret?.installedVersion &&
    storedReport.bundleVersion !== zapret.installedVersion
  const testReport = reportIsStale ? null : storedReport
  const [cancelling, setCancelling] = useState(false)
  const [expandedStrategy, setExpandedStrategy] = useState<string | null>(null)

  const refreshStrategies = useCallback(async (): Promise<
    { file: string; title: string; description: string }[]
  > => {
    try {
      const list = await zapretListStrategies()
      setStrategies(list)
      return list
    } catch {
      setStrategies([])
      return []
    }
  }, [])

  const startTest = useCallback((): void => {
    // Installing rewrites the bundle on disk; starting a sweep mid-install
    // would test the old strategies and then lose them on the swap.
    if (installingRef.current) return
    if (useZapretTestStore.getState().isRunning) return
    // Optimistically flip isRunning so the UI dims immediately — the
    // first 'starting' IPC tick will arrive within ~100ms and reconcile.
    useZapretTestStore.getState().set({
      isRunning: true,
      progress: { phase: 'starting' }
    })
    zapretRunStrategyTest().catch((e: unknown) => {
      const msg = e instanceof Error ? e.message : String(e)
      toast.error('Тест стратегий не выполнен', { description: msg })
      useZapretTestStore.getState().set({
        isRunning: false,
        progress: { phase: 'error', message: msg }
      })
    })
  }, [])

  // One strategy listing per mount: the auto-test below reuses this state
  // instead of issuing a second `zapretListStrategies` request.
  useEffect(() => {
    void refreshStrategies()
  }, [refreshStrategies])

  // The sweep is explicit: opening the page must not start a multi-minute
  // test or disable the power switch. The user starts it from the button.

  // Automatic update check honours `zapret.checkUpdates` inside the shared
  // hook. Background errors stay silent: the banner is simply absent.
  const showBanner = updateBannerVisible(updateInfo)

  const installUpdate = async (): Promise<void> => {
    if (installingRef.current || !updateInfo?.tag) return
    installingRef.current = true
    setInstalling(true)
    const tId = toast.loading('Скачиваем сборку Zapret…', {
      description: updateInfo.assetName ?? `v${updateInfo.latest}`
    })
    try {
      const res = await zapretInstallUpdate(updateInfo.tag)
      // Drop the manual result before the re-check: the freshly installed
      // bundle is the new baseline, and a failed check must not bring the old
      // banner back.
      updateCheck.clearManual()
      toast.success('Zapret обновлён', {
        id: tId,
        description: `Версия ${res.installedVersion ?? updateInfo.latest} — стратегий: ${res.strategies}`,
        // Same vivid power-on green as the other success toasts (copy-link,
        // regenerate-key, processes-reloaded) and the active home-page
        // power-on disc, so success feedback across the app is one colour.
        style: POWER_ON_BANNER_STYLE
      })
      // If the active strategy no longer exists in the new bundle, drop it
      // so the user is forced to pick a fresh one before next start.
      const fresh = await refreshStrategies()
      setBundleRefreshKey((k) => k + 1)
      if (active && !fresh.some((s) => s.file === active)) {
        // Leaf-only patch: the install above just persisted the new
        // version, so sending a pre-install `zapret` snapshot would roll it
        // back. A failed clear is already toasted by `patchAppConfig`.
        await patchAppConfig(zapretPatch({ activeStrategy: undefined }))
      }
      // Re-check so the banner disappears immediately; a failed re-check must
      // not turn a successful install into an error toast.
      try {
        await updateCheck.check()
      } catch {
        /* banner refreshes on the next automatic check */
      }
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e)
      // Stale banner tag: refresh the cached check so the banner carries the
      // tag main expects and a second click succeeds.
      if (await updateCheck.recoverFromTagMismatch(e)) {
        toast.dismiss(tId)
      } else {
        toast.error('Не удалось обновить Zapret', { id: tId, description: msg })
      }
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
        toast.info(`Доступно обновление Zapret v${fresh.latest}`, {
          description: 'Нажмите «Обновить» в баннере выше.'
        })
      } else {
        toast.success('У вас последняя версия Zapret', {
          description: `v${fresh.installed ?? BUNDLED_ZAPRET_VERSION}`,
          style: POWER_ON_BANNER_STYLE
        })
      }
    } catch (e) {
      toast.error('Не удалось проверить обновления', {
        description: e instanceof Error ? e.message : String(e)
      })
    }
  }

  const pickStrategy = async (file: string): Promise<void> => {
    // Defensive: if the user manages to click a disabled strategy via
    // keyboard or a stale render, drop the request silently.
    const r = testReport?.results[file]
    if (r && r.tested && !r.passed) return
    if (isTestRunning || installing) return
    // A failure is toasted by `patchAppConfig`; don't auto-start with the old
    // strategy or claim the selection landed.
    const saved = await patchAppConfig(zapretPatch({ activeStrategy: file }))
    if (!saved) return
    if (!autoStartRef.current) return
    // One-shot: drop the flag so re-clicking another strategy on this page
    // doesn't keep auto-starting and ping-ponging back to Home.
    autoStartRef.current = false
    try {
      await zapretStart()
      navigate('/home')
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e)
      toast.error('Не удалось запустить Zapret', { description: msg })
    }
  }

  const cancelTest = async (): Promise<void> => {
    if (cancelling) return
    setCancelling(true)
    try {
      const cancelled = await zapretCancelStrategyTest()
      if (!cancelled) {
        toast.info('Тест стратегий уже завершён')
      }
    } catch (e) {
      toast.error('Не удалось отменить тест стратегий', {
        description: e instanceof Error ? e.message : String(e)
      })
    } finally {
      setCancelling(false)
    }
  }

  return (
    <BasePage title="Zapret">
      <div className="px-4 pb-6 space-y-4">
        {showBanner && updateInfo && (
          <UpdateBanner
            kind="zapret"
            info={updateInfo}
            installing={installing}
            onInstall={() => { void installUpdate() }}
            onDismiss={dismissUpdate}
          />
        )}

        <SwitcherCard
          icon={ZapretIcon}
          title="Обход DPI (Zapret)"
          subtitle={active ?? 'Выберите стратегию ниже'}
          version={zapret?.installedVersion ?? updateInfo?.installed ?? BUNDLED_ZAPRET_VERSION}
          status={status}
          disabled={isTestRunning || installing}
          onToggle={(v) => {
            if (v && !active) return
            if (isTestRunning || installing) return
            // Return the promise so SwitcherCard awaits the IPC roundtrip,
            // keeps the switch optimistically flipped/locked until done and
            // surfaces a rejected start/stop with the main-process message.
            return v ? zapretStart() : zapretStop()
          }}
          footer={
            installing
              ? 'Устанавливаем обновление…'
              : isTestRunning
                ? 'Идёт тестирование стратегий — переключатель временно недоступен'
                : active
                  ? null
                  : 'Нужна стратегия'
          }
        />

        <div className="flex items-center justify-between gap-3 rounded-lg border border-stroke bg-card/40 px-4 py-2">
          <div className="flex min-w-0 flex-col">
            <span className="text-sm">Обновления Zapret</span>
            <span className="text-xs text-muted-foreground truncate">
              v{zapret?.installedVersion ?? updateInfo?.installed ?? BUNDLED_ZAPRET_VERSION} ·
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

      <ZapretNetworkCard
        refreshKey={bundleRefreshKey}
        disabled={isTestRunning || status.state === 'starting' || status.state === 'stopping'}
        disabledReason={
          isTestRunning
            ? 'Идёт тестирование стратегий — настройки фильтров временно недоступны'
            : 'Подождите завершения переключения Zapret'
        }
      />

      <ZapretMaintenanceCard
        refreshKey={bundleRefreshKey}
        disabled={isTestRunning || status.state === 'starting' || status.state === 'stopping'}
        disabledReason={
          isTestRunning
            ? 'Идёт тестирование стратегий — обслуживание временно недоступно'
            : 'Подождите завершения переключения Zapret'
        }
      />

      <ZapretFakesCard
        refreshKey={bundleRefreshKey}
        disabled={isTestRunning || status.state === 'starting' || status.state === 'stopping'}
        disabledReason={
          isTestRunning
            ? 'Идёт тестирование стратегий — замена фейков временно недоступна'
            : 'Подождите завершения переключения Zapret'
        }
      />

      <ZapretIpListCard
        refreshKey={bundleRefreshKey}
        disabled={isTestRunning || status.state === 'starting' || status.state === 'stopping'}
        disabledReason={
          isTestRunning
            ? 'Идёт тестирование стратегий — управление списком временно недоступно'
            : 'Подождите завершения переключения Zapret'
        }
      />

      <Card>
        <CardHeader
          className={cn(
            'flex flex-row items-center justify-between gap-3 space-y-0',
            isTestRunning && 'flex-col items-stretch gap-3 sm:flex-row sm:items-center'
          )}
        >
          {isTestRunning ? (
            // Inline progress bar replacing the title row during testing.
            <div className="flex flex-1 min-w-0 items-center gap-3">
              <Loader2 className="h-4 w-4 shrink-0 animate-spin text-primary" />
              <div className="min-w-0 flex-1">
                <div className="text-sm font-medium leading-tight">
                  Идёт тестирование стратегий под вас. Пожалуйста подождите...
                </div>
                <div className="text-xs text-muted-foreground mt-0.5">
                  После завершения тестирования придёт уведомление в приложении.
                  {testProgress && testProgress.total ? (
                    <>
                      {' '}
                      Стратегия{' '}
                      <span className="font-mono">
                        {testProgress.current ?? 0}/{testProgress.total}
                      </span>
                      {testProgress.strategy ? (
                        <>
                          {' — '}
                          <span className="font-mono">{testProgress.strategy}</span>
                        </>
                      ) : null}
                    </>
                  ) : null}
                </div>
              </div>
              <Button
                variant="outline"
                size="sm"
                onClick={() => { void cancelTest() }}
                disabled={cancelling}
                className="shrink-0"
                title="Остановить перебор стратегий и вернуть прежнюю"
              >
                {cancelling
                  ? <Loader2 className="h-3.5 w-3.5 animate-spin" />
                  : <XCircle className="h-3.5 w-3.5" />}
                Отменить тест
              </Button>
            </div>
          ) : (
            <>
              <CardTitle className="flex items-center gap-2">
                Стратегии
                {testReport ? (
                  <span className="text-xs font-normal text-muted-foreground">
                    {Object.values(testReport.results).filter((r) => r.passed).length}
                    {' / '}
                    {Object.keys(testReport.results).length} рабочих
                  </span>
                ) : null}
              </CardTitle>
              <Button
                variant="outline"
                size="sm"
                onClick={startTest}
                disabled={strategies.length === 0 || installing}
                title={
                  installing
                    ? 'Устанавливаем обновление — тест стратегий временно недоступен'
                    : undefined
                }
                className="shrink-0"
              >
                <FlaskConical className="h-3.5 w-3.5" />
                {testReport ? 'Перетестировать' : 'Запустить тест'}
              </Button>
            </>
          )}
        </CardHeader>
        <CardContent className="space-y-2">
          {strategies.length === 0 && (
            <p className="text-sm text-muted-foreground">
              Сборка Zapret не найдена. Переустановите SkipNet или нажмите «Обновить»
              в баннере обновления выше — стратегии поставляются во встроенной папке{' '}
              <code className="text-xs">resources\zapret</code>.
            </p>
          )}
          {strategies.map((s) => {
            const result = testReport?.results[s.file]
            // 0 successful HTTP/TLS checks means the strategy never passed
            // traffic on this network, so it stays unselectable like before.
            const isFailed = !!result && result.tested && !result.passed
            const isPassed = !!result && result.tested && result.passed
            const isBest = !!result && result.passed && testReport?.bestStrategy === s.file
            const disabled = isFailed || isTestRunning || installing
            const pingTotal = result ? result.pingOkCount + result.pingFailCount : 0
            const expanded = expandedStrategy === s.file
            return (
              <div
                key={s.file}
                className={cn(
                  'rounded-md border transition',
                  active === s.file
                    ? 'border-primary bg-primary/10'
                    : 'border-border',
                  disabled && 'opacity-40 grayscale'
                )}
              >
                <div className="flex items-stretch">
                  <button
                    onClick={() => { void pickStrategy(s.file) }}
                    disabled={disabled}
                    aria-disabled={disabled}
                    title={
                      isFailed
                        ? `Не прошла тест: HTTP ${result?.okCount ?? 0}/${result?.totalCount ?? 0}. Нажмите «Перетестировать», чтобы повторить проверку.`
                        : isTestRunning
                          ? 'Тестирование стратегий — подождите окончания.'
                          : undefined
                    }
                    className={cn(
                      'group relative min-w-0 flex-1 text-left p-3 rounded-md transition',
                      !disabled && 'hover:bg-accent/30',
                      disabled && 'cursor-not-allowed pointer-events-none'
                    )}
                  >
                    <div className="flex items-center gap-2">
                      <div className="min-w-0 flex-1">
                        <div className="font-medium text-sm flex items-center gap-2">
                          <span className="truncate">{s.title}</span>
                          {isBest && (
                            <span className="shrink-0 text-[10px] uppercase tracking-wide font-semibold rounded px-1.5 py-0.5 bg-primary/20 text-primary">
                              лучшая
                            </span>
                          )}
                        </div>
                        {s.description && (
                          <div className="text-xs text-muted-foreground mt-0.5">{s.description}</div>
                        )}
                        {result ? (
                          <div className="mt-1 flex flex-wrap items-center gap-x-2 gap-y-0.5 text-[11px] text-muted-foreground font-mono">
                            <span>
                              HTTP {result.okCount}/{result.totalCount}
                            </span>
                            <span>· ping {result.pingOkCount}/{pingTotal}</span>
                            {result.unsupportedCount > 0 && (
                              <span className="text-amber-400">UNSUP {result.unsupportedCount}</span>
                            )}
                            {result.errorCount > 0 && (
                              <span className="text-red-400">ERR {result.errorCount}</span>
                            )}
                          </div>
                        ) : null}
                      </div>
                      {isFailed ? (
                        <span className="shrink-0 inline-flex items-center gap-1 text-[11px] text-red-400">
                          <XCircle className="h-3.5 w-3.5" />
                          {result?.okCount ?? 0}/{result?.totalCount ?? 0}
                        </span>
                      ) : isPassed ? (
                        <span className="shrink-0 inline-flex items-center gap-1 text-[11px] text-emerald-400">
                          <CheckCircle2 className="h-3.5 w-3.5" />
                          {result?.okCount ?? 0}/{result?.totalCount ?? 0}
                        </span>
                      ) : null}
                    </div>
                  </button>
                  {result && result.targets?.length > 0 ? (
                    <button
                      onClick={() => setExpandedStrategy(expanded ? null : s.file)}
                      aria-expanded={expanded}
                      aria-label={`Подробности теста ${s.title}`}
                      title="Подробности по целям"
                      className="shrink-0 border-l border-stroke px-2 text-muted-foreground hover:text-foreground"
                    >
                      <ChevronDown
                        className={cn('h-4 w-4 transition-transform', expanded && 'rotate-180')}
                      />
                    </button>
                  ) : null}
                </div>
                {expanded && result ? (
                  <div className="border-t border-stroke px-3 py-2 space-y-1">
                    {result.targets.map((t) => (
                      <div
                        key={t.name}
                        className="flex flex-wrap items-center justify-between gap-x-3 gap-y-0.5 text-[11px] font-mono"
                      >
                        <span className="text-muted-foreground">{t.name}</span>
                        <span className="flex flex-wrap items-center gap-1.5">
                          {t.checks.map((c) => (
                            <span
                              key={c.label}
                              className={cn(
                                c.status === 'ok'
                                  ? 'text-emerald-400'
                                  : c.status === 'unsup'
                                    ? 'text-amber-400'
                                    : 'text-red-400'
                              )}
                            >
                              {c.label}:
                              {c.status === 'ok'
                                ? 'OK'
                                : c.status === 'unsup'
                                  ? 'UNSUP'
                                  : c.status === 'ssl'
                                    ? 'SSL'
                                    : 'ERR'}
                            </span>
                          ))}
                          <span
                            className={cn(
                              t.ping === 'ok'
                                ? 'text-sky-400'
                                : t.ping === 'fail'
                                  ? 'text-red-400'
                                  : 'text-muted-foreground'
                            )}
                          >
                            ping{' '}
                            {t.ping === 'ok'
                              ? t.pingMs !== undefined
                                ? `${t.pingMs} ms`
                                : 'OK'
                              : t.ping === 'fail'
                                ? 'timeout'
                                : 'n/a'}
                          </span>
                        </span>
                      </div>
                    ))}
                  </div>
                ) : null}
              </div>
            )
          })}
        </CardContent>
      </Card>

      {status.lastError && (
        <Card className="border" style={POWER_OFF_BANNER_STYLE}>
          <CardContent className="pt-4">
            <p className="text-sm">{status.lastError}</p>
          </CardContent>
        </Card>
      )}
      </div>
    </BasePage>
  )
}

export default Zapret
