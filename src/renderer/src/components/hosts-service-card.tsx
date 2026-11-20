import { memo } from 'react'
import { CheckCircle2 } from 'lucide-react'
import { Switch } from '@renderer/components/ui/switch'
import HostsServiceIcon from '@renderer/components/hosts-service-icon'
import { cn } from '@renderer/lib/utils'
import { pluralRu } from '@renderer/lib/plural'
import { defaultProfileFor, profileOptionsFor } from '@renderer/lib/hosts-profile'

interface Props {
  service: HostsService
  selection: HostsSelection | undefined
  profiles: HostsDnsProfile[]
  defaultDnsProfile: string | undefined
  busy: boolean
  disabled: boolean
  onSetService: (service: HostsService, value: HostsSelection) => void
}

function isEnabled(selection: HostsSelection | undefined): boolean {
  return !!selection && selection !== 'off'
}

function domainCount(service: HostsService): number {
  return service.kind === 'hosts'
    ? (service.entries?.length ?? 0)
    : (service.domains?.length ?? 0)
}

function profileName(profiles: HostsDnsProfile[], id: string): string {
  return profiles.find((profile) => profile.id === id)?.name ?? id
}

/**
 * One catalog card.
 *
 * Memoised on primitives plus the stable `service` / `profiles` references
 * from the retained catalog: a mutation only changes `selection` for the
 * service the user actually touched, so the other ~100 cards skip rendering
 * even though the hosts RPC returns a fresh overview object.
 */
const HostsServiceCard = memo(function HostsServiceCard({
  service,
  selection,
  profiles,
  defaultDnsProfile,
  busy,
  disabled,
  onSetService
}: Props) {
  const on = isEnabled(selection)
  const currentProfile =
    service.kind === 'dns'
      ? on && typeof selection === 'string' && selection !== 'hosts'
        ? selection
        : defaultProfileFor(service, profiles, defaultDnsProfile)
      : 'hosts'
  // The current value is always part of the list (stored profile without
  // answers, or 'off'), otherwise the browser would display the first option
  // instead of the real selection (R21).
  const profileOptions = profileOptionsFor(service, profiles, currentProfile)

  return (
    <div
      className={cn(
        'flex items-start gap-3 rounded-xl border p-3 transition',
        on ? 'border-primary/50 bg-primary/5' : 'border-stroke bg-card/40',
        busy && 'opacity-60'
      )}
    >
      <div className="flex size-9 shrink-0 items-center justify-center rounded-lg bg-muted/60">
        <HostsServiceIcon service={service} className="size-5" />
      </div>
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-1.5">
          <span className="truncate text-sm font-medium">{service.name}</span>
          {on && <CheckCircle2 className="size-3.5 shrink-0 text-emerald-400" />}
        </div>
        <div className="text-[11px] text-muted-foreground">
          {domainCount(service)} {pluralRu(domainCount(service), ['домен', 'домена', 'доменов'])}
          {on && service.kind === 'dns' ? ` · ${profileName(profiles, currentProfile)}` : ''}
        </div>
        {service.kind === 'dns' ? (
          <select
            value={currentProfile}
            onChange={(event) => onSetService(service, event.target.value)}
            disabled={disabled || !on}
            title={on ? 'DNS-профиль' : 'Сначала включите сервис'}
            aria-label={`DNS-профиль: ${service.name}`}
            className={cn(
              'mt-1 h-7 max-w-full rounded-md border border-stroke bg-card/60 px-1.5 text-[11px] text-muted-foreground',
              'outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-stroke',
              !on && 'opacity-60'
            )}
          >
            {profileOptions.map((profile) => (
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
        aria-label={service.name}
        onCheckedChange={(checked) => {
          const value: HostsSelection = checked
            ? service.kind === 'hosts'
              ? 'hosts'
              : defaultProfileFor(service, profiles, defaultDnsProfile)
            : 'off'
          onSetService(service, value)
        }}
      />
    </div>
  )
})

export default HostsServiceCard
