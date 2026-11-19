import {
  _electron as electron,
  expect,
  test,
  type ElectronApplication,
  type Page
} from '@playwright/test'
import { createRequire } from 'node:module'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'

/**
 * Renderer smoke test for the built Electron app.
 *
 * Isolation:
 *  - a unique `--user-data-dir` under `os.tmpdir()` keeps `%APPDATA%\skipnet`
 *    (and the dev profile) untouched and gives this instance its own
 *    single-instance lock;
 *  - `test-e2e/electron-main.cjs` loads the real main bundle but disables the
 *    OS integration that is out of scope (URL handlers, scheduled tasks,
 *    service control, process kills), so the run cannot alter the host;
 *  - the app is launched unpackaged, which is the app's dev mode: it skips the
 *    packaged-build admin check and does not package anything.
 *
 * The suite never clicks apply/toggle/start/update controls.
 */

interface AllowedPattern {
  pattern: RegExp
  reason: string
}

interface RendererIssue {
  kind: 'pageerror' | 'console.error'
  text: string
  url: string
}

interface IgnoredIssue extends RendererIssue {
  reason: string
}

// Explicit allow-list for noise that is not produced by SkipNet's renderer.
// Anything not matched here fails the suite.
const IGNORED_CONSOLE_ERRORS: AllowedPattern[] = [
  {
    pattern: /Autofill\.(enable|setAddresses)/,
    reason: 'Chromium DevTools protocol noise'
  },
  {
    pattern: /DevTools failed to load source map/i,
    reason: 'DevTools source-map loader noise'
  },
  {
    pattern: /Electron Security Warning/i,
    reason: 'Electron security warning emitted as a console error'
  }
]

const IGNORED_PAGE_ERRORS: AllowedPattern[] = [
  {
    pattern: /ResizeObserver loop (?:limit exceeded|completed with undelivered notifications)\.?/i,
    reason: 'Chromium layout-observer noise'
  },
  {
    pattern: /^Script error\.?$/i,
    reason: 'Cross-origin script error without details'
  }
]

const rendererIssues: RendererIssue[] = []
const ignoredIssues: IgnoredIssue[] = []

function recordIssue(
  kind: RendererIssue['kind'],
  text: string,
  url: string,
  allowList: AllowedPattern[]
): void {
  const normalized = text.trim()
  const allowed = allowList.find((entry) => entry.pattern.test(normalized))
  if (allowed) {
    ignoredIssues.push({ kind, text: normalized, url, reason: allowed.reason })
    return
  }
  rendererIssues.push({ kind, text: normalized, url })
}

function attachRendererListeners(target: Page): void {
  target.on('pageerror', (error) => {
    recordIssue('pageerror', error.message, target.url(), IGNORED_PAGE_ERRORS)
  })
  target.on('console', (message) => {
    if (message.type() !== 'error') return
    recordIssue('console.error', message.text(), target.url(), IGNORED_CONSOLE_ERRORS)
  })
}

let electronApp: ElectronApplication | undefined
let page: Page | undefined
let userDataDir: string | undefined

function getPage(): Page {
  if (!page) throw new Error('Electron main window was not created')
  return page
}

function sidebarButton(name: RegExp) {
  return getPage().locator('[data-slot="sidebar"]').first().getByRole('button', { name })
}

async function navigateTo(buttonName: RegExp, hashPath: string, heading: RegExp): Promise<void> {
  const target = getPage()
  const button = sidebarButton(buttonName)
  await expect(button, `sidebar entry ${buttonName}`).toBeVisible()
  await button.click()
  await expect(target).toHaveURL(new RegExp(`#${hashPath.replace(/\//g, '\\/')}$`))
  // `BasePage` renders the page heading in its stable `.title` header; the
  // cards themselves have no heading roles. The regexes accept RU and EN.
  await expect(target.locator('.title').first()).toHaveText(heading)
}

test.describe.serial('SkipNet renderer smoke', () => {
  test.beforeAll(async () => {
    const electronRequire = createRequire(__filename)
    const electronBinary = electronRequire('electron') as string
    const appRoot = path.resolve(__dirname, '..')

    userDataDir = mkdtempSync(path.join(tmpdir(), 'skipnet-e2e-'))

    // A minimal config blocks the legacy-profile migration and makes the
    // destructive feature defaults explicit. `getAppConfig` merges the rest
    // from `defaultConfig`; dev mode also forces autoStart/autoLaunch off.
    writeFileSync(
      path.join(userDataDir, 'config.yaml'),
      [
        'appTheme: dark',
        'configVersion: 4',
        'autoLaunch: false',
        'silentStart: false',
        'disableTray: false',
        'tgws:',
        '  autoStart: false',
        'zapret:',
        '  autoStart: false',
        ''
      ].join('\n')
    )

    electronApp = await electron.launch({
      executablePath: electronBinary,
      args: [path.join(__dirname, 'electron-main.cjs'), `--user-data-dir=${userDataDir}`],
      cwd: appRoot,
      timeout: 30_000
    })

    // Attach before awaiting the first window so a startup error is not lost.
    electronApp.on('window', attachRendererListeners)
    page = await electronApp.firstWindow({ timeout: 30_000 })
    attachRendererListeners(page)
  })

  // eslint-disable-next-line no-empty-pattern -- afterEach has no fixture to request
  test.afterEach(async ({}, testInfo) => {
    if (!page || page.isClosed()) return
    if (testInfo.status !== 'failed' && testInfo.status !== 'timedOut') return

    const screenshotPath = testInfo.outputPath('failure.png')
    mkdirSync(path.dirname(screenshotPath), { recursive: true })
    await page.screenshot({ path: screenshotPath, fullPage: true }).catch(() => undefined)
    await testInfo
      .attach('failure.png', { path: screenshotPath, contentType: 'image/png' })
      .catch(() => undefined)
  })

  test.afterAll(async () => {
    let closeError: unknown

    try {
      if (electronApp) {
        const processHandle = electronApp.process()
        const exited = new Promise<number | null>((resolve) => {
          if (processHandle.exitCode !== null) resolve(processHandle.exitCode)
          else processHandle.once('exit', (code) => resolve(code))
        })

        await electronApp.close()
        // A window still listed here means `close()` did not tear the app down.
        expect(electronApp.windows(), 'a window stayed open after Electron close').toHaveLength(0)
        expect(await exited, 'Electron exited with a non-zero code').toBe(0)
      }
    } catch (error) {
      closeError = error
    } finally {
      if (userDataDir) {
        try {
          rmSync(userDataDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
        } catch {
          // A leftover temp profile is annoying, not a test failure.
        }
      }
    }

    if (closeError) throw closeError
  })

  test('launches the main window and redirects to #/home', async () => {
    const target = getPage()
    await expect(target).toHaveTitle('SkipNet')
    await expect(target).toHaveURL(/#\/home$/)
    await expect(target.locator('[data-slot="sidebar"]').first()).toBeVisible()
    await expect(sidebarButton(/^(Главная|Home)$/i)).toBeVisible()
    expect(electronApp?.windows()).toHaveLength(1)
  })

  test('navigates the sidebar to hosts, settings, logs and zapret', async () => {
    await navigateTo(/^Hosts$/i, '/hosts', /(Редактор hosts|Hosts editor)/i)
    await navigateTo(/^(Настройки|Settings)$/i, '/settings', /^(Настройки|Settings)$/)
    await navigateTo(/^(Логи|Logs)$/i, '/logs', /^(Логи|Logs)$/)
    await navigateTo(/^Zapret$/i, '/zapret', /^Zapret$/i)
    await navigateTo(/^(Главная|Home)$/i, '/home', /^$/)
  })

  test('shows a non-empty hosts catalog without applying anything', async () => {
    const target = getPage()
    await navigateTo(/^Hosts$/i, '/hosts', /(Редактор hosts|Hosts editor)/i)
    await expect(target.getByText('сервисов включено в hosts')).toBeVisible()

    // Section headers render "<enabled> из <total>". The catalog is read-only
    // here: no toggle, apply, refresh or host-file button is clicked.
    const totals = target.locator('span').filter({ hasText: /^\d+ из \d+$/ })
    await expect
      .poll(
        async () => {
          const texts = await totals.allTextContents()
          return texts.reduce((sum, text) => {
            const match = text.match(/^(\d+) из (\d+)$/)
            return sum + (match ? Number(match[2]) : 0)
          }, 0)
        },
        { message: 'hosts catalog should render at least one service', timeout: 20_000 }
      )
      .toBeGreaterThan(0)
  })

  test('renders the autostart and tray switches without toggling them', async () => {
    const target = getPage()
    await navigateTo(/^(Настройки|Settings)$/i, '/settings', /^(Настройки|Settings)$/)

    const autoLaunch = target.locator('#settings-auto-launch')
    const tray = target.locator('#settings-tray-icon')

    await expect(autoLaunch).toBeVisible()
    await expect(tray).toBeVisible()
    await expect(autoLaunch).toHaveAttribute('role', 'switch')
    await expect(tray).toHaveAttribute('role', 'switch')
    await expect(autoLaunch).toHaveAttribute('aria-checked', /^(true|false)$/)
    await expect(tray).toHaveAttribute('aria-checked', /^(true|false)$/)
    await expect(target.getByText('Запускать при входе в Windows', { exact: true })).toBeVisible()
    await expect(target.getByText('Иконка в трее', { exact: true })).toBeVisible()

    // Deliberately no click: rendering is all this smoke needs.
  })

  test('emits no renderer page errors or console errors', async () => {
    if (ignoredIssues.length > 0) {
      test.info().annotations.push({
        type: 'ignored renderer noise',
        description: ignoredIssues
          .map((issue) => `${issue.kind}: ${issue.text} (${issue.reason})`)
          .join(' | ')
      })
    }

    const details = rendererIssues
      .map((issue) => `[${issue.kind}] ${issue.text}\n  at ${issue.url}`)
      .join('\n')
    expect(rendererIssues, `Renderer emitted errors during the smoke run:\n${details}`).toEqual([])
  })
})
