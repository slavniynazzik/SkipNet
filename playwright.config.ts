import { defineConfig } from '@playwright/test'

/**
 * Electron smoke suite.
 *
 * There is deliberately no browser project here: the tests launch the built
 * Electron app through `_electron.launch`, so no Playwright browser download is
 * required. `pnpm test:e2e` builds `out/` first and then runs this config.
 */
export default defineConfig({
  testDir: './test-e2e',
  // One Electron app owns one temporary profile; parallel workers would only
  // duplicate launch/shutdown cost.
  fullyParallel: false,
  workers: 1,
  timeout: 60_000,
  expect: {
    timeout: 10_000
  },
  retries: 0,
  reporter: 'list',
  outputDir: 'test-results/e2e'
})
