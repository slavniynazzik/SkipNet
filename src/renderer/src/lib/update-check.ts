/**
 * Pure predicates behind the shared update-check hook.
 *
 * Kept free of React/SWR imports so the gating rules are unit-testable and
 * every page agrees on when a banner may be shown.
 */

export type UpdateKind = 'app' | 'zapret' | 'tgws'

/** SWR: one GitHub-backed check per component kind per 15 minutes. */
export const UPDATE_DEDUPING_MS = 15 * 60 * 1000

/**
 * Should the shared hook issue an automatic (non-forced) check?
 *
 * - `app` follows the persisted `autoCheckUpdate` switch.
 * - `zapret` follows `zapret.checkUpdates` (mirrors the bundle setting).
 * - `tgws` has no separate switch in `TgwsConfig`; its automatic check has
 *   always run whenever the config is available, and the per-tag
 *   `dismissedUpdateTag` is honoured by the payload (`dismissed`).
 *
 * A config that has not loaded yet returns false: no request before the
 * persisted switches are known, so a user who disabled auto-checks never sees
 * a stray request during startup.
 */
export function shouldAutoCheckUpdates(
  kind: UpdateKind,
  config: AppConfig | undefined
): boolean {
  if (!config) return false
  if (kind === 'app') return config.autoCheckUpdate !== false
  if (kind === 'zapret') return config.zapret?.checkUpdates !== false
  return true
}

/**
 * Version/tag persisted by `*:dismissUpdate`.
 *
 * The app updater stores the raw release tag (`v1.4.0`) and compares it with
 * the cached tag; the component updaters store the display version and compare
 * it with the cached release version. Passing the wrong one made the banner
 * reappear after the next check, so the mapping lives here.
 */
export function updateDismissTag(
  kind: UpdateKind,
  info: { tag?: string; latest?: string }
): string | undefined {
  return (kind === 'app' ? info.tag ?? info.latest : info.latest ?? info.tag) || undefined
}

/**
 * Result to cache after an explicit "Проверить" click.
 *
 * A manual check is a user request to see the latest state, so a previously
 * dismissed component update becomes visible again for this session (the
 * persisted dismissal still wins on the next automatic check). The app
 * overlay keeps main's `dismissed` flag because it is a full-screen modal.
 */
export function revealAfterManualCheck<
  T extends { hasUpdate: boolean; dismissed?: boolean }
>(kind: UpdateKind, info: T): T {
  if (kind === 'app' || !info.hasUpdate) return info
  return { ...info, dismissed: false }
}

/**
 * The single banner visibility rule used by Home, Telegram and Zapret.
 *
 * `sessionDismissed` hides a banner for the current mount only (the Home page
 * "X") without persisting anything.
 */
export function updateBannerVisible(
  info: { hasUpdate: boolean; tag?: string; dismissed?: boolean } | undefined,
  sessionDismissed = false
): boolean {
  return !!info && info.hasUpdate && !!info.tag && !info.dismissed && !sessionDismissed
}
