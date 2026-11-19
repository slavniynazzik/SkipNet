import React, { createContext, useContext, ReactNode } from 'react'
import { toast } from 'sonner'
import useSWR from 'swr'
import { getAppConfig, patchAppConfig as patch } from '@renderer/utils/ipc'
import type { AppConfigPatch } from '@renderer/lib/config-patch'

interface AppConfigContextType {
  appConfig: AppConfig | undefined
  mutateAppConfig: () => void
  /**
   * Persist a leaf-only config patch.
   *
   * Resolves `true` only when the main process accepted and wrote the patch.
   * On failure the error toast is shown here and the promise resolves `false`,
   * so call sites must not show a success toast (or optimistically update
   * local state) before checking the result.
   */
  patchAppConfig: (value: AppConfigPatch) => Promise<boolean>
}

const AppConfigContext = createContext<AppConfigContextType | undefined>(undefined)

export const AppConfigProvider: React.FC<{ children: ReactNode }> = ({ children }) => {
  const { data: appConfig, mutate: mutateAppConfig } = useSWR('getConfig', () => getAppConfig())

  const patchAppConfig = async (value: AppConfigPatch): Promise<boolean> => {
    try {
      await patch(value)
      return true
    } catch (e) {
      // The only failure toast for a config write. Pages must not add a
      // second one; they just skip their own success feedback.
      toast.error(`${e}`)
      return false
    } finally {
      // Revalidate after both outcomes: a failed patch may still have rolled a
      // side effect back (e.g. autoLaunch registration) and the UI must snap
      // back to the persisted value.
      mutateAppConfig()
    }
  }

  React.useEffect(() => {
    return window.skipnet.on('appConfigUpdated', () => {
      mutateAppConfig()
    })
  }, [])

  return (
    <AppConfigContext.Provider value={{ appConfig, mutateAppConfig, patchAppConfig }}>
      {children}
    </AppConfigContext.Provider>
  )
}

export const useAppConfig = (): AppConfigContextType => {
  const context = useContext(AppConfigContext)
  if (context === undefined) {
    throw new Error('useAppConfig must be used within an AppConfigProvider')
  }
  return context
}
