import { useEffect, useState } from 'react'
import { toast } from 'sonner'
import {
  AlertTriangle,
  CheckCircle2,
  ChevronDown,
  ChevronRight,
  FileText,
  Info,
  Loader2,
  RefreshCw,
  ShieldCheck,
  Terminal,
  Trash2,
  XCircle
} from 'lucide-react'
import { Card, CardContent, CardHeader, CardTitle } from '@renderer/components/ui/card'
import { Button } from '@renderer/components/ui/button'
import { Switch } from '@renderer/components/ui/switch'
import { cn } from '@renderer/lib/utils'
import { useNavigate } from 'react-router-dom'
import {
  zapretClearDiscordCache,
  zapretDiagnosticsFix,
  zapretGetAutoUpdateCheck,
  zapretRunDiagnostics,
  zapretRunTests,
  zapretSetAutoUpdateCheck,
  type DiagAction,
  type DiagCheck,
  type DiagStatus,
  type DiagnosticsReport
} from '@renderer/utils/ipc'

interface Props {
  disabled?: boolean
  disabledReason?: string
  refreshKey?: string | number
}

const ACTION_LABEL: Record<DiagAction['kind'], string> = {
  service: 'Служба',
  process: 'Процесс',
  path: 'Папка',
  command: 'Команда'
}

/**
 * Render the exact list of side effects returned by the main process. The
 * confirmation is shown *before* the destructive call; main repeats the
 * `confirmed` check and refuses without it, so a bypassed dialog changes
 * nothing (C9 / audit P1-12).
 */
function confirmDiagnosticActions(title: string, actions: DiagAction[]): boolean {
  const lines = actions.map(
    (action) => `• ${ACTION_LABEL[action.kind]}: ${action.target}\n    ${action.details}`
  )
  return window.confirm(`${title}\n\n${lines.join('\n')}\n\nПродолжить?`)
}

const ZapretMaintenanceCard: React.FC<Props> = ({ disabled = false, disabledReason, refreshKey }) => {
  const [open, setOpen] = useState(false)
  const navigate = useNavigate()
  const [autoUpdate, setAutoUpdate] = useState<boolean | null>(null)
  const [savingAuto, setSavingAuto] = useState(false)
  const [report, setReport] = useState<DiagnosticsReport | null>(null)
  const [diagBusy, setDiagBusy] = useState(false)
  const [fixing, setFixing] = useState<string | null>(null)
  const [testsBusy, setTestsBusy] = useState(false)
  const [discordBusy, setDiscordBusy] = useState(false)

  useEffect(() => {
    zapretGetAutoUpdateCheck().then(setAutoUpdate).catch(() => setAutoUpdate(null))
  }, [refreshKey])

  const toggleAutoUpdate = async (value: boolean): Promise<void> => {
    if (savingAuto) return
    setSavingAuto(true)
    try {
      const actual = await zapretSetAutoUpdateCheck(value)
      setAutoUpdate(actual)
      toast.success(actual ? 'Проверка обновлений включена' : 'Проверка обновлений отключена')
    } catch (e) {
      toast.error('Не удалось изменить настройку', {
        description: e instanceof Error ? e.message : String(e)
      })
    } finally {
      setSavingAuto(false)
    }
  }

  const runDiagnostics = async (silent = false): Promise<void> => {
    if (diagBusy) return
    setDiagBusy(true)
    const tId = silent ? undefined : toast.loading('Проверяем систему…')
    try {
      const result = await zapretRunDiagnostics()
      setReport(result)
      if (tId) {
        const bad = result.checks.filter((c) => c.status === 'fail').length
        const warn = result.checks.filter((c) => c.status === 'warn').length
        toast.success('Диагностика завершена', {
          id: tId,
          description: bad || warn ? `Проблем: ${bad}, предупреждений: ${warn}` : 'Проблем не найдено.'
        })
      }
    } catch (e) {
      if (tId) {
        toast.error('Диагностика не удалась', {
          id: tId,
          description: e instanceof Error ? e.message : String(e)
        })
      }
    } finally {
      setDiagBusy(false)
    }
  }

  const applyFix = async (check: DiagCheck): Promise<void> => {
    if (!check.fix || fixing) return
    setFixing(check.id)
    let shouldRefresh = false
    const tId = toast.loading('Готовим исправление…')
    try {
      // The first call is a preview: main refuses destructive fixes without
      // `confirmed` and returns the exact services/paths/commands involved.
      const preview = await zapretDiagnosticsFix(check.fix)
      if (preview.ok) {
        toast.success(preview.message, { id: tId })
        shouldRefresh = true
      } else if (!preview.actions?.length) {
        toast.info(preview.message, { id: tId })
      } else if (!confirmDiagnosticActions('Подтвердите исправление', preview.actions)) {
        toast.info('Отменено — изменения не применены', { id: tId })
      } else {
        const result = await zapretDiagnosticsFix(check.fix, true)
        if (result.ok) toast.success(result.message, { id: tId })
        else toast.error(result.message, { id: tId })
        shouldRefresh = true
      }
    } catch (e) {
      toast.error('Не удалось применить исправление', {
        id: tId,
        description: e instanceof Error ? e.message : String(e)
      })
    } finally {
      setFixing(null)
    }
    if (shouldRefresh) void runDiagnostics(true)
  }

  const runTests = async (): Promise<void> => {
    if (testsBusy) return
    setTestsBusy(true)
    try {
      const result = await zapretRunTests()
      if (result.started) toast.success(result.message)
      else toast.error(result.message)
    } catch (e) {
      toast.error('Не удалось запустить тесты', {
        description: e instanceof Error ? e.message : String(e)
      })
    } finally {
      setTestsBusy(false)
    }
  }

  const clearDiscord = async (): Promise<void> => {
    if (discordBusy) return
    setDiscordBusy(true)
    const tId = toast.loading('Проверяем кэш Discord…')
    try {
      // Preview first: without `confirmed` main refuses and returns the exact
      // process and folder list. Nothing is deleted until the user agrees.
      const preview = await zapretClearDiscordCache()
      if (!preview.actions.length) {
        toast.info(preview.message, { id: tId })
        return
      }
      if (!confirmDiagnosticActions('Закрыть Discord и удалить кэш?', preview.actions)) {
        toast.info('Отменено — ничего не удалено', { id: tId })
        return
      }
      const result = await zapretClearDiscordCache(true)
      if (result.failed.length) {
        toast.error(result.message, {
          id: tId,
          description: `Не удалось удалить: ${result.failed.join(', ')}`
        })
      } else {
        toast.success(result.message, {
          id: tId,
          description: `${result.cleared.length} папок удалено${
            result.closed.length ? `, закрыто: ${result.closed.join(', ')}` : ''
          }.`
        })
      }
    } catch (e) {
      toast.error('Не удалось очистить кэш Discord', {
        id: tId,
        description: e instanceof Error ? e.message : String(e)
      })
    } finally {
      setDiscordBusy(false)
    }
  }

  const locked = disabled
  const failures = report?.checks.filter((c) => c.status === 'fail').length ?? 0
  const warnings = report?.checks.filter((c) => c.status === 'warn').length ?? 0

  return (
    <Card>
      <CardHeader className="flex flex-wrap items-center justify-between gap-2 space-y-0">
        <CardTitle className="flex items-center gap-2">
          <ShieldCheck className="h-4 w-4 text-muted-foreground" />
          Обслуживание и диагностика
          {report && (
            <span
              className={cn(
                'text-xs font-normal',
                failures ? 'text-red-400' : warnings ? 'text-amber-400' : 'text-emerald-400'
              )}
            >
              {failures ? `${failures} проблем` : warnings ? `${warnings} предупреждений` : 'всё в порядке'}
            </span>
          )}
        </CardTitle>
        <div className="flex shrink-0 items-center gap-2">
          {open && (
            <Button
              variant="outline"
              size="sm"
              disabled={locked || diagBusy}
              onClick={() => { void runDiagnostics() }}
            >
              {diagBusy ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <RefreshCw className="h-3.5 w-3.5" />}
              Проверить
            </Button>
          )}
          <Button
            variant={open ? 'secondary' : 'outline'}
            size="sm"
            onClick={() => setOpen((v) => !v)}
          >
            {open
              ? <><ChevronDown className="h-3.5 w-3.5" /> Свернуть</>
              : <><ChevronRight className="h-3.5 w-3.5" /> Развернуть</>}
          </Button>
        </div>
      </CardHeader>
      {open && (
      <CardContent className="space-y-4">
        {disabled && disabledReason && (
          <p className="text-[11px] text-muted-foreground">{disabledReason}</p>
        )}

        <div className="flex items-center justify-between gap-3 rounded-lg border border-stroke bg-muted/20 px-3 py-2">
          <div className="min-w-0">
            <div className="text-sm">Проверка обновлений Zapret</div>
            <div className="text-[11px] text-muted-foreground">
              Управляет файлом <code className="text-[11px]">utils/check_updates.enabled</code>.
            </div>
          </div>
          <Switch
            checked={autoUpdate ?? false}
            disabled={locked || savingAuto || autoUpdate === null}
            onCheckedChange={(v) => { void toggleAutoUpdate(v) }}
          />
        </div>

        <div className="flex flex-wrap items-center justify-between gap-3 rounded-lg border border-stroke bg-muted/20 px-3 py-2">
          <div className="min-w-0">
            <div className="flex items-center gap-2 text-sm">
              <FileText className="h-4 w-4 text-muted-foreground" />
              Файл hosts
            </div>
            <div className="mt-0.5 text-[11px] text-muted-foreground">
              Сервисы, DNS-профили и записи управляются в отдельном редакторе.
            </div>
          </div>
          <Button size="sm" variant="outline" onClick={() => navigate('/hosts')}>
            Открыть редактор
          </Button>
        </div>

        {report ? (
          <div className="space-y-1.5">
            {report.checks.map((check) => (
              <div
                key={check.id}
                className="flex items-start gap-2 rounded-md border border-border/60 px-2.5 py-2"
              >
                <StatusIcon status={check.status} />
                <div className="min-w-0 flex-1">
                  <div className="text-sm">{check.title}</div>
                  {check.detail && (
                    <div className="mt-0.5 break-words text-[11px] text-muted-foreground">
                      {check.detail}
                    </div>
                  )}
                  {check.hint && check.status !== 'ok' && (
                    <div className="mt-0.5 text-[11px] text-muted-foreground">{check.hint}</div>
                  )}
                </div>
                {check.fix && (
                  <Button
                    size="sm"
                    variant="ghost"
                    onClick={() => { void applyFix(check) }}
                    disabled={locked || fixing !== null}
                  >
                    {fixing === check.id ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : null}
                    Исправить
                  </Button>
                )}
              </div>
            ))}
          </div>
        ) : (
          <p className="text-[11px] text-muted-foreground">
            Нажмите «Проверить», чтобы выполнить проверки BFE, прокси, TCP timestamps, конфликтов,
            VPN, DNS и hosts.
          </p>
        )}

        <div className="flex flex-wrap gap-2 border-t border-stroke pt-3">
          <Button size="sm" variant="outline" onClick={() => { void runTests() }} disabled={locked || testsBusy}>
            {testsBusy ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Terminal className="h-3.5 w-3.5" />}
            Запустить тесты
          </Button>
          <Button
            size="sm"
            variant="outline"
            onClick={() => { void clearDiscord() }}
            disabled={locked || discordBusy}
            className="text-red-400 hover:text-red-300"
          >
            {discordBusy ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Trash2 className="h-3.5 w-3.5" />}
            Очистить кэш Discord
          </Button>
        </div>
      </CardContent>
      )}
    </Card>
  )
}

const StatusIcon: React.FC<{ status: DiagStatus }> = ({ status }) => {
  if (status === 'ok') return <CheckCircle2 className="mt-0.5 h-4 w-4 shrink-0 text-emerald-400" />
  if (status === 'warn') return <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-amber-400" />
  if (status === 'fail') return <XCircle className="mt-0.5 h-4 w-4 shrink-0 text-red-400" />
  return <Info className="mt-0.5 h-4 w-4 shrink-0 text-muted-foreground" />
}

export default ZapretMaintenanceCard
