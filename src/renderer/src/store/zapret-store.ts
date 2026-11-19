import { create } from 'zustand'
import { zapretStatus } from '@renderer/utils/ipc'

interface ZapretStore {
  status: CoreStatus
  setStatus: (s: CoreStatus) => void
}

export const useZapretStore = create<ZapretStore>((set) => ({
  status: { state: 'stopped' },
  setStatus: (status): void => set({ status })
}))

export const attachZapretStore = (): (() => void) => {
  // The unsubscribe returned here removes only this registration, so a
  // StrictMode/HMR re-attach never leaves duplicate listeners behind.
  const off = window.skipnet.on('zapret:status', (...args) => {
    const [payload] = args as [CoreStatus]
    useZapretStore.getState().setStatus(payload)
  })
  zapretStatus().then((s) => useZapretStore.getState().setStatus(s)).catch(() => void 0)
  return off
}
