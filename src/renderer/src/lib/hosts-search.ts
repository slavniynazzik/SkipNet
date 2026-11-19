/**
 * Search predicate for the hosts page.
 *
 * Kept free of React imports so it can be unit-tested in the node test
 * environment and reused by any future filtering surface. The catalog has
 * ~100 services, so the match runs on every keystroke; the page feeds it a
 * deferred query so typing never blocks the card grid.
 */

/** Case-insensitive match against id, display name and catalog hostnames. */
export function matchesService(service: HostsService, query: string): boolean {
  const needle = query.trim().toLowerCase()
  if (!needle) return true
  if (service.name.toLowerCase().includes(needle) || service.id.toLowerCase().includes(needle)) {
    return true
  }
  const hostnames =
    service.kind === 'hosts'
      ? (service.entries ?? []).map((entry) => entry.hostname)
      : (service.domains ?? []).map((domain) => domain.hostname)
  return hostnames.some((hostname) => hostname.toLowerCase().includes(needle))
}
