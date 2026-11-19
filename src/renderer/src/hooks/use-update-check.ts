import { useCallback, useRef, useState, useSyncExternalStore } from 'react'
import { toast } from 'sonner'
import useSWR from 'swr'
import { useAppConfig } from '@renderer/hooks/use-app-config'
import {
  UPDATE_DEDUPING_MS,
  expectedTagFromError,
  resolveUpdateInfo,
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

const KIND_LABELS: Record<UpdateKind, string> = {
  app: 'SkipNet',
  zapret: 'Zapret',
  tgws: 'TgWsProxy'
}

/**
 * Session-wide results of explicit "Проверить" clicks.
 *
 * The SWR key is `null` while automatic checks are disabled, so the cache
 * cannot hold a manual result. This module-level store lives for the renderer
 * session instead: navigating from Settings to Telegram/Zapret/Home must keep
 * showing the banner an explicit check just found. `useSyncExternalStore`
 * lets every mounted hook observe the same per-kind entry without adding a
 * state-management dependency.
 */
const manualResults: Partial<UpdateInfoMap> = {}
const manualListeners = new Set<() => void>()

function readManualInfo<K extends UpdateKind>(kind: K): UpdateInfoMap[K] | undefined {
  return manualResults[kind]
}

function writeManualInfo<K extends UpdateKind>(
  kind: K,
  info: UpdateInfoMap[K] | undefined
): void {
  if (info === undefined) {
    if (!(kind in manualResults)) return
    delete manualResults[kind]
  } else {
    manualResults[kind] = info
  }
  for (const listener of manualListeners) listener()
}

function subscribeManual(listener: () => void): () => void {
  manualListeners.add(listener)
  return () => {
    manualListeners.delete(listener)
  }
}

export interface UseUpdateCheckResult<K extends UpdateKind> {
  kind: K
  /**
   * Result to render. The shared SWR cache while automatic checks are
   * enabled, otherwise the session's manual result (see `resolveUpdateInfo`).
   */
  info: UpdateInfoMap[K] | undefined
  /** Raw shared SWR entry, regardless of the gate. */
  sharedInfo: UpdateInfoMap[K] | undefined
  /** Raw result of the last explicit check, kept for the whole session. */
  manualInfo: UpdateInfoMap[K] | undefined
  /** False when the persisted switch (or a missing config) gates this check. */
  enabled: boolean
  /** True while an explicit `check()` is in flight. */
  checking: boolean
  /** Error from the last automatic/SWR check, if any. */
  error: unknown
  /**
   * Force a fresh IPC check, bypassing the 15-minute cache window, and store
   * the result in the shared SWR cache and the session manual store. Rejects
   * with the IPC error so the caller can show its own message (the automatic
   * path stays silent).
   */
  check: () => Promise<UpdateInfoMap[K]>
  /**
   * Revalidate the shared cache without forcing. Used by the update overlay's
   * hourly timer; failures are swallowed because it is a background refresh.
   * Resolves undefined when the automatic gate is off (no SWR key).
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
  /** Forget the manual result (successful install, or a hard reset). */
  clearManual: () => void
  /**
   * Recover from main's "tag mismatch" install rejection.
   *
   * Parses the tag main expects out of the error, refreshes the check result
   * (works with automatic checks disabled too, because `check()` always
   * forces) and toasts that the list was refreshed. Resolves false for any
   * other error so the caller can show its own install failure message.
   */
  recoverFromTagMismatch: (error: unknown) => Promise<boolean>
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

  const getManualInfo = useCallback(() => readManualInfo(kind), [kind])
  const manualInfo = useSyncExternalStore(subscribeManual, getManualInfo)
  const info = resolveUpdateInfo(enabled, data, manualInfo)

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
        // An explicit check is a request to see the latest state, so a
        // previously dismissed component update is revealed again for this
        // session. Both stores must carry the revealed value: the SWR cache is
        // what `resolveUpdateInfo` prefers while the gate is on.
        const revealed = revealAfterManualCheck(kind, fresh)
        // The manual store is the only place a result can live while the
        // automatic gate is off; with the gate on it keeps Settings and the
        // pages in sync even if the SWR write below fails.
        writeManualInfo(kind, revealed)
        if (enabled) {
          await mutate(revealed, { revalidate: false })
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

  const clearManual = useCallback((): void => {
    writeManualInfo(kind, undefined)
  }, [kind])

  const recoverFromTagMismatch = useCallback(
    async (error: unknown): Promise<boolean> => {
      const expected = expectedTagFromError(error)
      if (!expected) return false
      try {
        // Forced: main's cache is what the next install validates against, so
        // only a fresh check guarantees the banner carries an accepted tag.
        const fresh = await check()
        toast.info('Список обновлений обновлён', {
          description:
            fresh.hasUpdate && fresh.tag
              ? `${KIND_LABELS[kind]}: последняя версия — ${fresh.tag}. Нажмите «Обновить» ещё раз.`
              : `${KIND_LABELS[kind]}: обновлений больше нет.`
        })
        return true
      } catch (e) {
        toast.error('Не удалось обновить список обновлений', {
          description: e instanceof Error ? e.message : String(e)
        })
        return false
      }
    },
    [check, kind]
  )

  const dismiss = useCallback(
    async (target?: UpdateInfoMap[K]): Promise<boolean> => {
      const current = target ?? info
      const tag = current ? updateDismissTag(kind, current) : undefined
      if (!current || !tag) return false
      try {
        await DISMISSERS[kind](tag)
        // Never hide the banner before main confirms the dismissal (R12), so
        // a failed write cannot make the update silently disappear.
        const manual = readManualInfo(kind)
        if (manual || !enabled) {
          writeManualInfo(kind, { ...(manual ?? current), dismissed: true })
        }
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
    [enabled, info, kind, mutate]
  )

  return {
    kind,
    info,
    sharedInfo: data,
    manualInfo,
    enabled,
    checking,
    error,
    check,
    refresh,
    dismiss,
    clearManual,
    recoverFromTagMismatch
  }
}
