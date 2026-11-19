import { beforeEach } from 'vitest'
import { resetElectronMock } from './electron-mock'

// Every suite starts from a clean mock: no leaked windows, IPC handlers or
// packaged/dev flag overrides.
beforeEach(() => {
  resetElectronMock()
})
