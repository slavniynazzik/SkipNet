import { useEffect, useState } from 'react'
import { toast } from 'sonner'
import { ChevronDown, ChevronRight, Filter } from 'lucide-react'
import { Card, CardContent, CardHeader, CardTitle } from '@renderer/components/ui/card'
import { Button } from '@renderer/components/ui/button'
import { Input } from '@renderer/components/ui/input'
import { cn, POWER_ON_BANNER_STYLE } from '@renderer/lib/utils'
import {
  zapretGetGameFilter,
  zapretGetIpSetMode,
  zapretSetGameFilter,
  zapretSetIpSetMode,
  type GameFilterMode,
  type GameFilterSettings,
  type IpSetMode,
  type IpSetModeStatus
} from '@renderer/utils/ipc'

interface Props {
  disabled?: boolean
  disabledReason?: string
  /** Changes whenever the installed Zapret bundle changes, forcing a reload. */
  refreshKey?: string | number
}

const RESTART_HINT = 'Перезапустите Zapret, чтобы изменения применились.'

const GAME_MODES: Array<{ value: GameFilterMode; label: string; hint: string }> = [
  { value: 'disabled', label: 'Выключен', hint: 'Дополнительные правила не добавляются' },
  { value: 'all', label: 'TCP и UDP', hint: 'Фильтр по обоим протоколам' },
  { value: 'tcp', label: 'TCP', hint: 'Только TCP-порты' },
  { value: 'udp', label: 'UDP', hint: 'Только UDP-порты' }
]

const IPSET_MODES: Array<{ value: IpSetMode; label: string; hint: string }> = [
  { value: 'loaded', label: 'По списку', hint: 'Фильтровать только IP из ipset-all.txt' },
  { value: 'none', label: 'Отключён', hint: 'Ни один IP не попадает под фильтр' },
  { value: 'any', label: 'Все IP', hint: 'Правила применяются ко всем адресам' }
]

const ZapretNetworkCard: React.FC<Props> = ({ disabled = false, disabledReason, refreshKey }) => {
  const [open, setOpen] = useState(false)
  const [game, setGame] = useState<GameFilterSettings | null>(null)
  const [ipset, setIpSet] = useState<IpSetModeStatus | null>(null)
  const [tcpDraft, setTcpDraft] = useState('')
  const [udpDraft, setUdpDraft] = useState('')
  const [busy, setBusy] = useState(false)

  const load = async (): Promise<void> => {
    try {
      const [g, i] = await Promise.all([zapretGetGameFilter(), zapretGetIpSetMode()])
      setGame(g)
      setIpSet(i)
      setTcpDraft(g.tcpRange)
      setUdpDraft(g.udpRange)
    } catch {
      setGame(null)
      setIpSet(null)
    }
  }

  useEffect(() => {
    void load()
  }, [refreshKey])

  const applyGame = async (patch: {
    mode?: GameFilterMode
    tcpRange?: string
    udpRange?: string
  }): Promise<void> => {
    if (busy) return
    setBusy(true)
    const tId = toast.loading('Сохраняем настройки игрового фильтра…')
    try {
      const res = await zapretSetGameFilter(patch)
      setGame(res)
      setTcpDraft(res.tcpRange)
      setUdpDraft(res.udpRange)
      toast.success('Игровой фильтр обновлён', {
        id: tId,
        description: res.applied
          ? RESTART_HINT
          : 'Настройки сохранены и применятся после установки Zapret.',
        style: res.applied ? POWER_ON_BANNER_STYLE : undefined
      })
    } catch (e) {
      toast.error('Не удалось сохранить игровой фильтр', {
        id: tId,
        description: e instanceof Error ? e.message : String(e)
      })
    } finally {
      setBusy(false)
    }
  }

  const applyIpSet = async (mode: IpSetMode): Promise<void> => {
    if (busy || ipset?.mode === mode) return
    setBusy(true)
    const tId = toast.loading('Переключаем режим IPSet…')
    try {
      const res = await zapretSetIpSetMode(mode)
      setIpSet(res)
      toast.success('Режим IPSet обновлён', { id: tId, description: RESTART_HINT })
    } catch (e) {
      toast.error('Не удалось переключить IPSet', {
        id: tId,
        description: e instanceof Error ? e.message : String(e)
      })
    } finally {
      setBusy(false)
    }
  }

  const tcpActive = game?.mode === 'all' || game?.mode === 'tcp'
  const udpActive = game?.mode === 'all' || game?.mode === 'udp'
  const locked = disabled || busy

  return (
    <Card>
      <CardHeader className="flex flex-row items-center justify-between gap-3 space-y-0">
        <CardTitle className="flex items-center gap-2">
          <Filter className="h-4 w-4 text-muted-foreground" />
          Фильтры сети
          <span className="text-xs font-normal text-muted-foreground">
            игровой фильтр и режим IPSet
          </span>
        </CardTitle>
        <Button
          variant={open ? 'secondary' : 'outline'}
          size="sm"
          onClick={() => setOpen((v) => !v)}
          className="shrink-0"
        >
          {open
            ? <><ChevronDown className="h-3.5 w-3.5" /> Свернуть</>
            : <><ChevronRight className="h-3.5 w-3.5" /> Развернуть</>}
        </Button>
      </CardHeader>
      {open && (
      <CardContent className="space-y-5">
        {disabled && disabledReason && (
          <p className="text-[11px] text-muted-foreground">{disabledReason}</p>
        )}
        {!game || !ipset ? (
          <p className="text-sm text-muted-foreground">
            Установите или обновите Zapret-бандл, чтобы управлять фильтрами.
          </p>
        ) : (
          <>
            <div>
              <div className="mb-2 flex items-center justify-between gap-2">
                <span className="text-xs uppercase tracking-wide text-muted-foreground">
                  Игровой фильтр
                </span>
                <span
                  className={cn(
                    'shrink-0 rounded px-1.5 py-0.5 text-[10px] font-mono',
                    game.enabled
                      ? 'bg-primary/15 text-primary'
                      : 'bg-muted text-muted-foreground'
                  )}
                >
                  {game.enabled ? 'включён' : 'выключен'}
                </span>
              </div>
              <div className="grid gap-2 sm:grid-cols-2">
                {GAME_MODES.map((m) => (
                  <OptionButton
                    key={m.value}
                    active={game.mode === m.value}
                    disabled={locked}
                    label={m.label}
                    hint={m.hint}
                    onClick={() => { void applyGame({ mode: m.value }) }}
                  />
                ))}
              </div>

              <div className="mt-3 grid gap-2 sm:grid-cols-2">
                <RangeField
                  label="TCP-порты"
                  value={tcpDraft}
                  onChange={setTcpDraft}
                  disabled={locked || !tcpActive}
                  onApply={() => { void applyGame({ tcpRange: tcpDraft }) }}
                />
                <RangeField
                  label="UDP-порты"
                  value={udpDraft}
                  onChange={setUdpDraft}
                  disabled={locked || !udpActive}
                  onApply={() => { void applyGame({ udpRange: udpDraft }) }}
                />
              </div>
              <p className="mt-1.5 text-[11px] text-muted-foreground">
                Формат: <code className="text-[11px]">1024-65535</code> или{' '}
                <code className="text-[11px]">1024-1934,1936-65535</code>. Порты 1–65535.
              </p>
            </div>

            <div className="border-t border-stroke pt-4">
              <div className="mb-2 flex items-center justify-between gap-2">
                <span className="text-xs uppercase tracking-wide text-muted-foreground">
                  IPSet (список IP)
                </span>
                <span className="shrink-0 rounded bg-muted px-1.5 py-0.5 text-[10px] font-mono text-muted-foreground">
                  {ipset.entries} записей
                </span>
              </div>
              <div className="grid gap-2 sm:grid-cols-3">
                {IPSET_MODES.map((m) => (
                  <OptionButton
                    key={m.value}
                    active={ipset.mode === m.value}
                    disabled={locked || (m.value === 'loaded' && !ipset.hasBackup && ipset.mode !== 'loaded')}
                    label={m.label}
                    hint={m.hint}
                    onClick={() => { void applyIpSet(m.value) }}
                  />
                ))}
              </div>
              <p className="mt-1.5 text-[11px] text-muted-foreground">
                «По списку» использует диапазоны из <code className="text-[11px]">ipset-all.txt</code>.
                Прежний список сохраняется в <code className="text-[11px]">.backup</code>.
              </p>
            </div>
          </>
        )}
      </CardContent>
      )}
    </Card>
  )
}

const OptionButton: React.FC<{
  active: boolean
  disabled?: boolean
  label: string
  hint: string
  onClick: () => void
}> = ({ active, disabled, label, hint, onClick }) => (
  <button
    type="button"
    onClick={onClick}
    disabled={disabled}
    aria-pressed={active}
    className={cn(
      'w-full rounded-md border p-2.5 text-left transition',
      active ? 'border-primary bg-primary/10' : 'border-border hover:bg-accent/30',
      disabled && 'cursor-not-allowed opacity-50 hover:bg-transparent'
    )}
  >
    <div className="text-sm font-medium">{label}</div>
    <div className="mt-0.5 text-[11px] leading-snug text-muted-foreground">{hint}</div>
  </button>
)

const RangeField: React.FC<{
  label: string
  value: string
  disabled?: boolean
  onChange: (value: string) => void
  onApply: () => void
}> = ({ label, value, disabled, onChange, onApply }) => (
  <div>
    <label className="mb-1 block text-[11px] text-muted-foreground">{label}</label>
    <div className="flex items-center gap-1.5">
      <Input
        value={value}
        onChange={(e) => onChange(e.target.value)}
        disabled={disabled}
        spellCheck={false}
        className="h-8 font-mono text-xs"
        aria-label={label}
      />
      <Button size="sm" variant="outline" onClick={onApply} disabled={disabled}>
        ОК
      </Button>
    </div>
  </div>
)

export default ZapretNetworkCard
