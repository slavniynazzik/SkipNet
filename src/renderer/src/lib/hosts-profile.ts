/**
 * DNS-profile selection helpers for the hosts page.
 *
 * The catalog only carries answers for a subset of (service, profile) pairs.
 * A profile with zero answers would render an empty managed block, so it must
 * never become the default; and a `<select>` whose `value` is not among its
 * options silently displays the first option instead of the real state.
 */

export function hasAnswers(service: HostsService, profileId: string): boolean {
  return (service.domains ?? []).some((domain) => (domain.answers[profileId]?.length ?? 0) > 0)
}

/** Synthetic option for "DNS service enabled but no usable profile". */
export const OFF_PROFILE: HostsDnsProfile = { id: 'off', name: 'Нет профиля', order: 0 }

/**
 * Initial profile used when the user enables a DNS service.
 *
 * Falls back to `'off'` when no profile has addresses for this service instead
 * of returning `profiles[0]` (which used to yield a service that was nominally
 * enabled but produced no entries).
 */
export function defaultProfileFor(
  service: HostsService,
  profiles: HostsDnsProfile[],
  preferred?: string
): string {
  if (service.kind !== 'dns') return 'hosts'
  if (preferred && hasAnswers(service, preferred)) return preferred
  return profiles.find((profile) => hasAnswers(service, profile.id))?.id ?? 'off'
}

/**
 * Options for the per-service profile picker.
 *
 * When at least one profile has answers only those are offered (the old
 * behaviour); otherwise every profile is listed so the user can still see the
 * catalog. The current value is always inserted: a stored profile that has no
 * answers (or `'off'`) stays visible and matches the actual selection.
 */
export function profileOptionsFor(
  service: HostsService,
  profiles: HostsDnsProfile[],
  selected: string
): HostsDnsProfile[] {
  const usable = profiles.filter((profile) => hasAnswers(service, profile.id))
  const options = usable.length > 0 ? [...usable] : [...profiles]

  if (!selected || selected === 'off') {
    if (!options.some((profile) => profile.id === 'off')) options.unshift(OFF_PROFILE)
    return options
  }
  if (!options.some((profile) => profile.id === selected)) {
    const stored = profiles.find((profile) => profile.id === selected)
    options.unshift(stored ?? { id: selected, name: selected, order: 0 })
  }
  return options
}
