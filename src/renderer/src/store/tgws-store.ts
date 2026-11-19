import { create } from 'zustand'
import { tgwsStatus } from '@renderer/utils/ipc'

interface TgwsStore {
  status: CoreStatus
  setStatus: (s: CoreStatus) => void
}

export const useTgwsStore = create<TgwsStore>((set) => ({
  status: { state: 'stopped' },
  setStatus: (status): void => set({ status })
}))

export const attachTgwsStore = (): (() => void) => {
  // The unsubscribe returned here removes only this registration, so a
  // StrictMode/HMR re-attach never leaves duplicate listeners behind.
  const off = window.skipnet.on('tgws:status', (...args) => {
    const [payload] = args as [CoreStatus]
    useTgwsStore.getState().setStatus(payload)
  })
  tgwsStatus().then((s) => useTgwsStore.getState().setStatus(s)).catch(() => void 0)
  return off
}
