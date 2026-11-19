import { useCallback, useRef, useState } from 'react'
import { toast } from 'sonner'
import useSWR from 'swr'
import { useAppConfig } from '@renderer/hooks/use-app-config'
import {
  UPDATE_DEDUPING_MS,
  revealAfterManualCheck,
  shouldAutoCheckUpdates,
  updateDismissTag,
  type UpdateKind
} from '@renderer/lib/update-check'
import {
  appCheckUpdate,
  appDismissUpdate,
  tgwsCheckUpdate,
  tgwsDismissUpdate,
  zapretCheckUpdate,
  zapretDismissUpdate,
  type AppUpdateInfo,
  type TgwsUpdateInfo,
  type ZapretUpdateInfo
} from '@renderer/utils/ipc'

export interface UpdateInfoMap {
  app: AppUpdateInfo
  zapret: ZapretUpdateInfo
  tgws: TgwsUpdateInfo
}

const CHECKERS = {
  app: (force: boolean) => appCheckUpdate(force),
  zapret: (force: boolean) => zapretCheckUpdate(force),
  tgws: (force: boolean) => tgwsCheckUpdate(force)
} satisfies { [K in UpdateKind]: (force: boolean) => Promise<UpdateInfoMap[K]> }

const DISMISSERS = {
  app: appDismissUpdate,
  zapret: zapretDismissUpdate,
  tgws: tgwsDismissUpdate
} satisfies { [K in UpdateKind]: (tag: string) => Promise<void> }

export interface UseUpdateCheckResult<K extends UpdateKind> {
  kind: K
  /** Cached check result; undefined until the first successful check. */
  info: UpdateInfoMap[K] | undefined
  /** False when the persisted switch (or a missing config) gates this check. */
  enabled: boolean
  /** True while an explicit `check()` is in flight. */
  checking: boolean
  /** Error from the last automatic/SWR check, if any. */
  error: unknown
  /**
   * Force a fresh IPC check, bypassing the 15-minute cache window, and store
   * the result in the shared SWR cache. Rejects with the IPC error so the
   * caller can show its own message (the automatic path stays silent).
   */
  check: () => Promise<UpdateInfoMap[K]>
  /**
   * Revalidate the shared cache without forcing. Used by the update overlay's
   * hourly timer; failures are swallowed because it is a background refresh.
   */
  refresh: () => Promise<UpdateInfoMap[K] | undefined>
  /**
   * Persist `*:dismissUpdate` in main, then hide the banner. Resolves false
   * (and keeps the banner visible) when the write failed.
   *
   * `target` lets the overlay dismiss a manually checked result that is not in
   * the SWR cache because automatic checks are disabled.
   */
  dismiss: (target?: UpdateInfoMap[K]) => Promise<boolean>
}

/**
 * One cached update check per component kind.
 *
 * Every page that shows an update banner uses this hook, so mounting Home,
 * Telegram, Zapret and Settings no longer fires four independent GitHub API
 * calls (60/h anonymous limit). SWR shares one cache entry per kind, the
 * 15-minute deduping window collapses mount/revalidation storms into one
 * request, and manual "check now" buttons call `check()` which always forces
 * a fresh IPC round-trip.
 */
export function useUpdateCheck<K extends UpdateKind>(kind: K): UseUpdateCheckResult<K> {
  const { appConfig } = useAppConfig()
  const enabled = shouldAutoCheckUpdates(kind, appConfig)

  const { data, error, mutate } = useSWR<UpdateInfoMap[K]>(
    enabled ? ['update-check', kind] : null,
    () => CHECKERS[kind](false) as Promise<UpdateInfoMap[K]>,
    {
      dedupingInterval: UPDATE_DEDUPING_MS,
      revalidateOnFocus: false,
      revalidateOnReconnect: false,
      shouldRetryOnError: false,
      keepPreviousData: true
    }
  )

  const [checking, setChecking] = useState(false)
  const inflightRef = useRef<Promise<UpdateInfoMap[K]> | null>(null)

  const check = useCallback((): Promise<UpdateInfoMap[K]> => {
    // A double click on "Проверить" must not fire two GitHub requests; the
    // second caller shares the first promise.
    if (inflightRef.current) return inflightRef.current
    setChecking(true)
    const run = (async (): Promise<UpdateInfoMap[K]> => {
      try {
        const fresh = await (CHECKERS[kind](true) as Promise<UpdateInfoMap[K]>)
        // Only the shared cache can be updated when the hook owns a key;
        // Settings still shows the fresh result even with auto-check off.
        if (enabled) {
          await mutate(revealAfterManualCheck(kind, fresh), { revalidate: false })
        }
        return fresh
      } finally {
        inflightRef.current = null
        setChecking(false)
      }
    })()
    inflightRef.current = run
    return run
  }, [enabled, kind, mutate])

  const refresh = useCallback(async (): Promise<UpdateInfoMap[K] | undefined> => {
    if (!enabled) return undefined
    try {
      return await mutate()
    } catch {
      // Background refresh: the previous banner data stays on screen.
      return undefined
    }
  }, [enabled, mutate])

  const dismiss = useCallback(
    async (target?: UpdateInfoMap[K]): Promise<boolean> => {
      const current = target ?? data
      const tag = current ? updateDismissTag(kind, current) : undefined
      if (!current || !tag) return false
      try {
        await DISMISSERS[kind](tag)
        // Never hide the banner before main confirms the dismissal (R12), so
        // a failed write cannot make the update silently disappear.
        if (enabled) {
          await mutate({ ...current, dismissed: true } as UpdateInfoMap[K], {
            revalidate: false
          })
        }
        return true
      } catch (e) {
        if (enabled) await mutate(current, { revalidate: false })
        toast.error('Не удалось отложить обновление', {
          description: e instanceof Error ? e.message : String(e)
        })
        return false
      }
    },
    [data, enabled, kind, mutate]
  )

  return { kind, info: data, enabled, checking, error, check, refresh, dismiss }
}
