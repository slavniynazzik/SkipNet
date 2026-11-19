import { resolve } from 'node:path'
import { defineConfig } from 'vitest/config'

/**
 * Unit-test harness for the Electron main process.
 *
 * Everything under `src/main` imports `electron` directly. In Node there is no
 * Electron runtime, so the alias below swaps the module for a deterministic
 * stub that only exposes in-memory / temp-directory implementations. Tests
 * must never require admin rights, the network, the registry or the real
 * hosts file.
 */
export default defineConfig({
  resolve: {
    alias: {
      electron: resolve(__dirname, 'test/setup/electron-mock.ts'),
      '@electron-toolkit/utils': resolve(__dirname, 'test/setup/electron-toolkit-utils-mock.ts'),
      '@main': resolve(__dirname, 'src/main')
    }
  },
  define: {
    // `electron.vite.config.ts` injects this at build time. Tests provide a
    // fixed value so `getAppConfig` never hits an undefined global.
    __BUILD_ID__: JSON.stringify('test-build-id')
  },
  test: {
    environment: 'node',
    globals: true,
    include: ['test/**/*.test.ts'],
    setupFiles: ['test/setup/setup.ts'],
    restoreMocks: true,
    coverage: {
      provider: 'v8',
      reporter: ['text', 'html', 'lcov'],
      include: ['src/main/core/**', 'src/main/utils/**'],
      exclude: ['**/*.d.ts']
    }
  }
})
