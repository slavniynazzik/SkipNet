import { useEffect, useState } from 'react'
import { toast } from 'sonner'
import { ChevronDown, ChevronRight, Layers } from 'lucide-react'
import { Card, CardContent, CardHeader, CardTitle } from '@renderer/components/ui/card'
import { Button } from '@renderer/components/ui/button'
import { cn } from '@renderer/lib/utils'
import {
  zapretGetFakes,
  zapretReplaceFake,
  type FakeKind,
  type FakesStatus
} from '@renderer/utils/ipc'

interface Props {
  disabled?: boolean
  disabledReason?: string
  refreshKey?: string | number
}

const ZapretFakesCard: React.FC<Props> = ({ disabled = false, disabledReason, refreshKey }) => {
  const [open, setOpen] = useState(false)
  const [status, setStatus] = useState<FakesStatus | null>(null)
  const [discordPick, setDiscordPick] = useState('')
  const [gamePick, setGamePick] = useState('')
  const [busy, setBusy] = useState<FakeKind | null>(null)

  const load = async (): Promise<void> => {
    try {
      const s = await zapretGetFakes()
      setStatus(s)
      setDiscordPick(s.discord.current ?? s.fakes[0]?.name ?? '')
      setGamePick(s.game.current ?? s.fakes[0]?.name ?? '')
    } catch {
      setStatus(null)
    }
  }

  useEffect(() => {
    void load()
  }, [refreshKey])

  const replace = async (kind: FakeKind, name: string): Promise<void> => {
    if (!name || busy) return
    setBusy(kind)
    const tId = toast.loading('Заменяем активный фейк…')
    try {
      const s = await zapretReplaceFake(kind, name)
      setStatus(s)
      setDiscordPick(s.discord.current ?? discordPick)
      setGamePick(s.game.current ?? gamePick)
      toast.success('Активный фейк заменён', {
        id: tId,
        description: 'Перезапустите Zapret, чтобы изменения применились.'
      })
    } catch (e) {
      toast.error('Не удалось заменить фейк', {
        id: tId,
        description: e instanceof Error ? e.message : String(e)
      })
    } finally {
      setBusy(null)
    }
  }

  const locked = disabled || busy !== null

  return (
    <Card>
      <CardHeader className="flex flex-row items-center justify-between gap-3 space-y-0">
        <CardTitle className="flex items-center gap-2">
          <Layers className="h-4 w-4 text-muted-foreground" />
          Активные фейки
          {status && (
            <span className="text-xs font-normal text-muted-foreground">
              {status.fakes.length} файлов в bin
            </span>
          )}
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
      <CardContent className="space-y-3">
        {disabled && disabledReason && (
          <p className="text-[11px] text-muted-foreground">{disabledReason}</p>
        )}
        {!status || !status.available ? (
          <p className="text-sm text-muted-foreground">
            Папка <code className="text-xs">bin</code> Zapret не найдена. Установите или обновите
            бандл.
          </p>
        ) : (
          <>
            <FakeRow
              label="Discord UDP"
              current={status.discord.current}
              value={discordPick}
              fakes={status.fakes.map((f) => f.name)}
              disabled={locked}
              onChange={setDiscordPick}
              onApply={() => { void replace('discord', discordPick) }}
              busy={busy === 'discord'}
            />
            <FakeRow
              label="GameFilter UDP"
              current={status.game.current}
              value={gamePick}
              fakes={status.fakes.map((f) => f.name)}
              disabled={locked}
              onChange={setGamePick}
              onApply={() => { void replace('game', gamePick) }}
              busy={busy === 'game'}
            />
            <p className="text-[11px] text-muted-foreground">
              Файл копируется в <code className="text-[11px]">ACTIVE_DISCORD_UDP.bin</code> или{' '}
              <code className="text-[11px]">ACTIVE_GAME_UDP.bin</code>. После замены перезапустите
              Zapret.
            </p>
          </>
        )}
      </CardContent>
      )}
    </Card>
  )
}

const FakeRow: React.FC<{
  label: string
  current: string | null
  value: string
  fakes: string[]
  disabled?: boolean
  busy?: boolean
  onChange: (value: string) => void
  onApply: () => void
}> = ({ label, current, value, fakes, disabled, busy, onChange, onApply }) => (
  <div className="flex flex-wrap items-end gap-2">
    <div className="min-w-0 flex-1">
      <div className="mb-1 flex items-center justify-between gap-2">
        <label className="text-[11px] text-muted-foreground">{label}</label>
        <span className="truncate text-[10px] font-mono text-muted-foreground">
          сейчас: {current ?? 'не определён'}
        </span>
      </div>
      <select
        value={value}
        onChange={(e) => onChange(e.target.value)}
        disabled={disabled}
        aria-label={label}
        className={cn(
          'h-9 w-full min-w-0 rounded-xl border border-stroke bg-card/50 px-3 text-sm',
          'outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-stroke',
          disabled && 'cursor-not-allowed opacity-50'
        )}
      >
        {fakes.length === 0 && <option value="">Нет файлов</option>}
        {fakes.map((name) => (
          <option key={name} value={name}>
            {name}
          </option>
        ))}
      </select>
    </div>
    <Button
      size="sm"
      variant="outline"
      onClick={onApply}
      disabled={disabled || !value || value === current}
    >
      {busy ? 'Замена…' : 'Заменить'}
    </Button>
  </div>
)

export default ZapretFakesCard
