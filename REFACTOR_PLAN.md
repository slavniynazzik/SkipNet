# План рефакторинга SkipNet 1.5.0 / Refactor Plan

Репозиторий: `C:\Users\nazar\Desktop\SkipNet` · HEAD `77360d8` · Electron 37 / React 19 / TS 5.9 / pnpm · текущая версия 1.4.0.
Документ: только план, ни один пункт не меняет код до отдельного коммита. Каждый таск = отдельный PR с зелёным CI.

## Принципы / Principles

1. Никакого переписывания стека: те же Electron + electron-vite + React, тот же NSIS и кастомный апдейтер.
2. Сначала тест-харнесс (Фаза 0), потом правки. Тест, фиксирующий баг, коммитится до фикса.
3. Пользовательские настройки (`%APPDATA%\skipnet\config.yaml`, `hosts-state.json`, секрет TgWs) переживают все обновления.
4. Не трогаем: `hosts-render.ts` / `hosts-editor.ts` (кроме точечных правок C1/C4/C8), пайплайн записи конфига (atomic wx + backup + rename), allow-list `skipnet-media://`, basename allow-list стратегий Zapret, NSIS upgrade-marker, таксономию "мёртвые пины vs нет интернета".
5. Порядок фаз строгий: 0 -> 1 -> 2 -> 3 -> 4. Фаза 1 обязана попасть в релиз 1.5.0.

## Workstreams

| WS | Тема | Фаза | Таски |
|----|------|------|-------|
| A | Тест-харнесс и CI | 0 | T0.1-T0.5 |
| B | Безопасность (P0) | 1 | S1-S9 |
| C | Корректность и устойчивость | 2 | C1-C12 |
| D | Качество, дублирование, мёртвый код | 3 | Q1-Q8 |
| E | Релиз и документация | 4 | R1-R4 |

---

## Фаза 0: Safety net
### T0.1 · Vitest-харнесс · P0 · M · deps: -
`new: vitest.config.ts, test/setup/electron-mock.ts, tsconfig.test.json; edit: package.json`
- **Change**: devDep `vitest` + `@vitest/coverage-v8`; скрипты `test` = `vitest run`, `test:watch`, `test:coverage`; `include: [test/**/*.test.ts]`, `environment: node`, alias `electron` -> `test/setup/electron-mock.ts` (заглушки `app.getPath`, `ipcMain`, `BrowserWindow`, `dialog`, `shell`), `@main` -> `src/main`. Тесты не требуют admin-прав, сети и реестра; `fetch` всегда стабится.
- **Accept**: `pnpm test` зелёный; `pnpm test:coverage` печатает таблицу; ни один тест не ходит в сеть (`vi.stubGlobal`). **Rollback**: удалить конфиг и devDep, прод-код не затронут.
### T0.2 · Первые юнит-сьюты · P0 · M · deps: T0.1
`new: test/hosts-render.test.ts, test/merge.test.ts, test/zapret-settings.test.ts, test/hosts-state.test.ts`
- **Change**: hosts-render: round-trip `buildHostsContent` -> `parseEditorBlock` (идемпотентность, порядок строк); `assertBalancedBlocks` бросает на дубле END, на BEGIN без END, на перепутанном порядке; `stripManagedBlocks` не меняет чужие строки байт-в-байт; `hashHostsContent` стабилен при CRLF->LF. merge: приоритет `key!`, замена массивов, вложенный merge, `it.fails` на `__proto__` (станет `it` после S6). validateGameFilterRange: `1024-65535` ok; `0-65535`, `65536-65536`, reversed, пустая строка, пробелы, буквы -> null. hosts-state: битый JSON не бросает, неизвестные сервисы отбрасываются.
- **Accept**: >=25 кейсов зелёные; покрытие `hosts-render.ts` >= 60% строк. **Rollback**: тесты независимы, удаляются без следа.
### T0.3 · Экстракт `update-integrity` + RED-тест · P0 · S · deps: T0.1
`new: src/main/core/update-integrity.ts, test/update-integrity.test.ts; edit: src/main/core/app-updater.ts (263-277)`
- **Change**: вынести `verifyInstaller` в чистый модуль без импортов electron: `verifyInstaller(buf, { digest, size, minBytes })`; `app-updater.ts` вызывает его. Тест: пустой digest **должен** бросать (`it.fails` до S1), `sha256:zz`, `md5:...`, несовпадение размера -> throw; корректный digest и uppercase-hex -> ok.
- **Accept**: поведение не изменилось; 6 кейсов; `it.fails` помечен комментарием. **Rollback**: вернуть функцию в `app-updater.ts`.
### T0.4 · CI: тесты и typecheck тестов · P0 · S · deps: T0.1-T0.3
`.github/workflows/ci.yml; package.json; tsconfig.test.json`
- **Change**: после Lint добавить `pnpm typecheck:test` (`tsc -p tsconfig.test.json --noEmit`) и `pnpm test -- --coverage`; `tsconfig.test.json` extends `tsconfig.node.json`, `types: [node, vitest/globals]`, include `test/**/*.ts` + `src/main/**/*.ts`. NUL-check Markdown сохранить.
- **Accept**: CI зелёный; намеренно сломанный тест валит job; job <= 6 мин. **Rollback**: убрать шаги, вернуть прежний CI.
### T0.5 · Ручной smoke-чеклист · P0 · S · deps: -
`new: docs/manual-smoke.md`
- **Change**: 8 сценариев из матрицы верификации с ожидаемым результатом и полями "версия / дата / подпись".
- **Accept**: чеклист используется в каждом PR фаз 2-4. **Rollback**: n/a.

---

## Фаза 1: P0 Security
### S1 · Обязательный digest для всех апдейтеров · P0 · M · deps: T0.3
`src/main/core/update-integrity.ts; app-updater.ts (321-336); zapret-updater.ts; tgws-updater.ts`
- **Change**: `verifyInstaller` бросает "Отсутствует контрольная сумма" при пустом digest; принимает строго `^sha256:[0-9a-f]{64}$`; `size` обязателен и > 0; `minBytes` (5 MB) обязателен; убрать ранний `if (!digest) return` и `SKIPNET_UPDATE_ALLOW_SMALL` вне `is.dev`. Тот же helper применить в zapret/tgws (там та же дыра).
- **Accept**: тест "missing digest -> throw" переведён из `it.fails` в `it`; ни один путь установки не запускает `.exe` без sha256; `grep SKIPNET_UPDATE_ALLOW_SMALL` только в dev-ветке. **Rollback**: revert, helper остаётся (совместим).
### S2 · Метаданные только с api.github.com, зеркала только для ассетов · P0 · M · deps: -
`src/main/utils/github.ts; app-updater.ts (17-28, 180-215); zapret-updater.ts; tgws-updater.ts; test/github-mirrors.test.ts`
- **Change**: развести `fetchGithubApi()` (единственный кандидат `https://api.github.com/...`, без зеркал и env-оверрайдов) и `fetchReleaseAsset(url, { owner, repo, tag })`, который принимает только `https://github.com/<owner>/<repo>/releases/download/<tag>/...` плюс redirect-цепочку `objects.githubusercontent.com`, и только для них подставляет `gh-proxy.com` / `ghfast.top`. `MIRRORS` один константный список, сторонних хостов в метаданных нет.
- **Accept**: юнит-тест: URL вне allow-list даёт ровно `[url]`; API-URL без зеркал; digest проверяется после скачивания. **Rollback**: revert (старое поведение = зеркала везде).
### S3 · Установка по тегу, без URL/digest от рендерера · P0 · L · deps: S1, S2
`app-updater.ts; zapret-updater.ts; tgws-updater.ts; src/main/utils/ipc.ts (278-305); renderer/src/utils/ipc.ts; src/preload/index.d.ts`
- **Change**: каналы принимают `tag: string` (regex `^v?\d+\.\d+\.\d+$`, совпадает с закэшированным последним релизом). Main сам берёт `browser_download_url`, `size`, `digest` (или `SHA256SUMS`-ассет того же релиза) и имя ассета по allow-list (`SkipNet-<ver>-x64.exe`, `*-portable.7z`, `zapret-*.zip`, `tgws-*.zip`). Рендерер не передаёт ни URL, ни digest, ни size.
- **Accept**: `grep -rn expectedDigest src/renderer` -> 0; подделанный тег -> `{ ok: false }`; ручной e2e: check -> install использует ассет, выбранный main-процессом. **Rollback**: вернуть старую сигнатуру только вместе с S1, иначе остаётся дыра.
### S4 · Preload allow-list + `sandbox: true` · P0 · L · deps: -
`src/preload/index.ts; src/preload/index.d.ts; src/main/index.ts (273-277); renderer/src/utils/ipc.ts; renderer/src/{App.tsx, i18n.ts, components/window-controls.tsx, hooks/use-app-config.tsx, store/*.ts}`
- **Change**: убрать `electronAPI` (сырой `ipcRenderer`, `process.env`, `webFrame`); экспонировать `window.skipnet = { invoke(channel, ...args), on(channel, cb), getPathForFile(file), platform }`, где `invoke` проверяет канал по frozen-списку из нового `src/shared/ipc-channels.ts` (72 записи). Включить `sandbox: true`, оставить `contextIsolation: true`, `nodeIntegration: false`. Перевести 29 вызовов `window.electron.ipcRenderer` в 9 файлах на `skipnet.invoke`.
- **Accept**: `grep -rn window.electron src/renderer` -> 0; неразрешённый канал отклоняется (юнит-тест `isAllowedChannel`); окно, DevTools, конфиг и логи работают. **Rollback**: revert целиком; `sandbox` это одна строка в `webPreferences`.
### S5 · Строгая проверка отправителя IPC · P0 · S · deps: S4
`src/main/utils/ipc.ts (229-237, 424-440); test/ipc-trust.test.ts`
- **Change**: вынести чистую `isTrustedFrameUrl(url, { devUrl, prodIndexUrl })`: разрешён ровно `file://`-URL нашего `out/renderer/index.html` (сравнение нормализованного пути) и точный origin `ELECTRON_RENDERER_URL`; убрать regex "любой `http://localhost:<port>`". Обработчики окна (424-440) обернуть в `h()`, чтобы они тоже проходили проверку и сериализовали ошибки.
- **Accept**: тесты: чужой `file:///C:/tmp/evil.html` -> false, `http://localhost:9999/` без devUrl -> false, свой index -> true; все window-хендлеры возвращают `{ ok: ... }`. **Rollback**: revert (одна функция и две обёртки).
### S6 · Защита `deepMerge` от prototype pollution · P0 · S · deps: T0.2
`src/main/utils/merge.ts; test/merge.test.ts`
- **Change**: итерация по `Object.keys` (только own), блок-лист `__proto__`, `constructor`, `prototype` после `trimWrap`, лимит глубины 32, merge только plain-объектов (`proto === Object.prototype` или null), присваивание без `Object.assign` по непроверенному ключу.
- **Accept**: `deepMerge({}, JSON.parse(...))` с `__proto__` не загрязняет `Object.prototype`; `constructor.prototype` тоже; прежние тесты merge зелёные; вредоносный YAML в конфиге безопасен. **Rollback**: revert (функция локальна, 4 вызова).
### S7 · Схема-валидация `app:patchConfig` · P0 · M · deps: S6
`new: src/main/config/schema.ts; src/main/config/app.ts (185-200); src/main/utils/ipc.ts (260); test/patch-config.test.ts`
- **Change**: ручной валидатор без новых зависимостей: allow-list ключей `AppConfig`, типы, enum (`theme`, `dnsProfile`), диапазоны (`port` 1024-65535, `bufKb`, `poolSize`), `tgws.secret` = 32 hex, `zapret.activeStrategy` из basename allow-list, запрет неизвестных ключей и лишней вложенности. Валидация до `deepMerge`; невалидный патч -> `{ ok: false }` без записи на диск.
- **Accept**: тесты: неизвестный ключ, строка вместо boolean, `__proto__`-payload, порт 80 -> отказ; все реальные поля `AppConfig` проходят (таблица ключей). **Rollback**: revert; запись конфига не менялась.
### S8 · Удалить `zapret:installBundle` · P0 · S · deps: -
`src/main/utils/ipc.ts (294-296); renderer/src/utils/ipc.ts (66-72); zapret-updater.ts (installZapretBundle + приватные helper-ы); src/preload/index.d.ts`
- **Change**: удалить канал, рендерер-обёртку, main-функцию, распаковку ZIP и запуск `.bat`/`winws.exe` с elevation. Обновление Zapret остаётся только через подписанный путь S1/S3.
- **Accept**: `grep -rn installBundle src` -> 0; `listStrategies`, `startZapret`, `checkUpdate` работают; typecheck зелёный. **Rollback**: revert (канал осознанно опасен, откат только для отладки).
### S9 · Редакция секретов в логах · P0 · S · deps: -
`new: src/main/utils/redact.ts; src/main/utils/app-logger.ts; src/main/core/tgws.ts (233, 267); test/redact.test.ts`
- **Change**: `redactSecrets(text)` маскирует `--secret <val>`, `secret=<hex>`, `tg://proxy?...secret=...`, 32-hex токены и точные значения из конфига (`tgws.secret`). Применить в `appLog` (единая точка выхода) и в логе спавна: вместо `args.join(" ")` писать `bin` + `args.map(mask).join(" ")`; строку 233 заменить на `secret OK (len=32)`.
- **Accept**: юнит-тесты на 6 шаблонов; `grep -n args.join src/main/core` -> 0; в Logs нет секрета (ручная проверка). **Rollback**: revert (только логирование).

---

## Фаза 2: P1 корректность и устойчивость
### C1 · Разделить блокировки hosts · P1 · L · deps: -
`src/main/core/hosts-editor.ts (80-100, 270, 490-500, 657-680, 672-748)`
- **Change**: `withStateLock` (короткий: чтение/запись файла и state) и `withProbeLock` (долгий DoH+TLS, отменяемый). `refreshHostsAddresses`: пробы вне state-лока, запись результата коротким локом; per-domain дедлайн вместо общего 300 с; `AbortController` отменяет пробы при действии пользователя; toggle не ждёт проб и сразу возвращает `refreshing: true`.
- **Accept**: при медленной сети включение/выключение сервиса отвечает < 200 мс и применяется; повторный refresh отменяет предыдущий; дедлайн не пишет в hosts. **Rollback**: revert к одному локу (поведение 1.4.0).
### C2 · Атомарный restart (zapret/tgws) · P1 · M · deps: -
`src/main/core/zapret.ts; src/main/core/tgws.ts; test/restart-lock.test.ts`
- **Change**: `restart()` берёт один operation-lock на `stopUnlocked()` -> `startUnlocked()`; конкурентные restart дедуплицируются в один pending promise; внешние stop/start ждут тот же lock.
- **Accept**: 10 быстрых start/stop/restart оставляют ровно один дочерний процесс; юнит-тест на тонком lock-модуле с fake timers. **Rollback**: revert (две независимые блокировки).
### C3 · Lifecycle: single-instance и корректный выход после апдейта · P1 · M · deps: -
`src/main/index.ts (42-45, 215-233); app-updater.ts (529-539)`
- **Change**: при неудачном `requestSingleInstanceLock()` вызвать `app.quit()` и немедленно выйти из модуля (`process.exit(0)` после quit либо ранний return из bootstrap-обёртки), top-level не продолжается. В апдейтере убрать `setTimeout(..., 1000)` + `process.exit(0)`: вызвать `app.quit()`, дождаться cleanup в `before-quit` (флаг `cleanupRan`), затем `app.exit(0)`.
- **Accept**: второй экземпляр не регистрирует IPC и не пишет конфиг (лог); при установке обновления в логе видны `stopTgws`/`stopZapret` до выхода; живых детей не остаётся. **Rollback**: revert.
### C4 · Восстановление `hosts-state.json` · P1 · M · deps: T0.2
`src/main/core/hosts-state.ts (156-168); hosts-editor.ts (reapply при старте)`
- **Change**: при ошибке парсинга переименовать файл в `hosts-state.corrupt-<ts>.json`, затем вывести state из managed-блока на диске (`parseEditorBlock`), а не "всё выключено"; `appLog(warn)` + баннер в UI "состояние восстановлено по файлу hosts".
- **Accept**: юнит-тест: битый JSON + валидный managed-блок -> state соответствует блоку, backup создан, hosts не тронут; без блока прежние defaults. **Rollback**: revert; backup-файл безвреден.
### C5 · XML-экранирование в Task Scheduler · P1 · S · deps: -
`src/main/sys/autoRun.ts (54-102)`
- **Change**: `escapeXml()` для `USERDOMAIN\USERNAME` и пути exe; проверка, что exe существует и путь абсолютный; при недопустимом имени пользователя понятная ошибка вместо битого XML.
- **Accept**: юнит-тест `escapeXml` (`& < > "`, non-ASCII); ручной тест: папка установки `R&D` -> задача создаётся и запускается. **Rollback**: revert.
### C6 · Env-оверрайды только в dev · P1 · S · deps: S2
`new: src/main/utils/dev-env.ts; app-updater.ts (17-28, 329); hosts-catalog.ts (394); zapret-lists.ts (39)`
- **Change**: единая `devEnv(name)`: значение только при `is.dev || !app.isPackaged`; все `SKIPNET_UPDATE_*`, `SKIPNET_HOSTS_CATALOG_URL`, `SKIPNET_ZAPRET_LISTS_BASE` идут через неё.
- **Accept**: `grep -rn process.env.SKIPNET_ src/main` находит только `dev-env.ts`; в собранном приложении переменные игнорируются (ручная проверка с выставленным env). **Rollback**: revert.
### C7 · Убивать процессы по PID, а не по имени образа · P1 · M · deps: -
`src/main/core/zapret.ts (247-253); tgws.ts (94-114); index.ts (183-203); app-updater.ts (375-384)`
- **Change**: хранить `{ pid, imagePath, startedAt }` для каждого spawn; завершать через `taskkill /PID <pid> /T` или `child.kill()`; kill по имени оставить только fallback с проверкой пути через `tasklist /FO CSV`. `ensurePortFree` освобождает только свой PID.
- **Accept**: ручной тест: своя копия `winws.exe` в другой папке переживает выход SkipNet; наши процессы умирают; 3 быстрых цикла start/stop без висяков. **Rollback**: revert (вернётся риск убийства чужих процессов, отметить в CHANGELOG).
### C8 · `openHostsFile` без elevation · P1 · S · deps: -
`src/main/core/hosts-editor.ts (823-827)`
- **Change**: не запускать редактор напрямую из elevated-процесса; `spawn("explorer.exe", [hostsFile])` либо `rundll32 url.dll,FileProtocolHandler`, путь строго равен системному hosts.
- **Accept**: на Win11 блокнот открывается непривилегированным; сохранение вызывает UAC, а не пишет молча. **Rollback**: revert (5 строк).
### C9 · Подтверждение разрушительных действий диагностики · P1 · S · deps: -
`src/main/core/zapret-diagnostics.ts (556-587); src/main/utils/ipc.ts; страница диагностики в renderer`
- **Change**: main принимает `{ confirmed: true }`; без флага no-op + запись в лог. В UI модалка со списком: kill `Discord.exe`, удаляемые cache-папки с точными путями.
- **Accept**: вызов без флага ничего не удаляет (тест); модалка показывает пути; ручной прогон на одноразовом профиле. **Rollback**: revert.
### C10 · Целостность релиза · P1 · M · deps: S1
`scripts/verify-dist.mjs; scripts/archive-release.mjs; scripts/checksum.mjs; electron-builder.yml; new: resources/binaries.sha256`
- **Change**: `verify-dist` считает sha256 для `winws.exe`, `WinDivert64.sys`, `TgWsProxy_windows.exe` и сверяет с checked-in манифестом (сборка падает при расхождении). `archive-release` пересобирает `SHA256SUMS` из свежих артефактов; устаревшие локальные копии `releases/v1.3.2` и `releases/v1.4.0` перегенерировать или внести `releases/**` в `.gitignore`; `latest.yml` либо использовать, либо перестать публиковать.
- **Accept**: подмена байта в `winws.exe` -> `pnpm verify:dist` fail; на свежем `build:win` pass; локальные SHA256SUMS совпадают с release.json. **Rollback**: проверку бинарников можно понизить до warn через dev-env, не откатывая скрипты.
### C11 · Ужесточить CSP и `skipnet-media://` · P1 · M · deps: S4
`src/renderer/index.html; src/main/core/wallpaper.ts; src/main/index.ts`
- **Change**: убрать `file:` из `img-src`/`media-src`; обои только через `skipnet-media://` (scheme: `standard, secure, supportFetchAPI`, `bypassCSP: false`, allow-list по префиксу пути как сейчас).
- **Accept**: обои рендерятся; `file://`-картинка произвольного пути блокируется (CSP в консоли); медиа-вкладка работает без CSP-ошибок. **Rollback**: вернуть `file:` в одну строку.
### C12 · Файловый лог с ротацией · P1 · M · deps: S9
`src/main/utils/app-logger.ts; src/main/utils/dirs.ts (logDir/logPath); src/main/utils/init.ts; config/schema.ts (maxLogDays)`
- **Change**: `appLog` дополнительно пишет JSONL в `logPath()` (лимит 5 MB, ротация по дням), prune старше `maxLogDays` (default 7); broadcast в рендерер сохраняется; перед записью `redactSecrets`.
- **Accept**: после запуска файл существует и растёт; ротация и prune проверены юнит-тестом с подменой mtime; секретов в файле нет; путь виден в Logs. **Rollback**: revert (broadcast-only).

---

## Фаза 3: P2 качество и мёртвый код
### Q1 · Один `compareVersion` · P2 · S · deps: T0.1
`new: src/shared/version.ts; app-updater.ts; zapret-updater.ts; tgws-updater.ts; hosts-catalog.ts; test/version.test.ts`
- **Change**: вынести реализацию, 4 вызова заменить.
- **Accept**: тесты (v-префикс, prerelease, build-metadata, равные) зелёные; `grep -c "function compareVersion"` -> 1. **Rollback**: revert.
### Q2 · Один `broadcast()` · P2 · S · deps: -
`new: src/main/utils/broadcast.ts; app-logger.ts; tgws.ts; zapret.ts; zapret-tester.ts`
- **Change**: единая функция с проверкой `isDestroyed()`, дубли удалить.
- **Accept**: `grep -c "function broadcast"` -> 1; поведение не меняется. **Rollback**: revert.
### Q3 · Общий `UpdateBanner` · P2 · M · deps: S3
`new: src/renderer/src/components/update-banner.tsx; pages/home; pages/telegram; pages/zapret`
- **Change**: props `{ kind, version, onInstall, onDismiss }`, логика check/dismiss/install по тегу внутри.
- **Accept**: визуальный паритет (скриншоты до/после); три страницы используют компонент; дубли удалены. **Rollback**: вернуть страничные копии.
### Q4 · Убрать циклические импорты через barrel `src/main/index.ts` · P2 · M · deps: -
`new: src/main/resolve/window-ref.ts; tray.ts; theme.ts; shortcut.ts; menu.ts; windowVisibility.ts; main/index.ts`
- **Change**: `getMainWindow()`/`setMainWindow()` в отдельном модуле, убрать импорт из родительского barrel.
- **Accept**: `madge --circular src/main` (добавить скрипт) -> 0 циклов; трей, меню, шорткаты работают. **Rollback**: revert.
### Q5 · Удаление мёртвого кода · P2 · M · deps: S4, S8
`renderer/src/**; src/main/core/*; src/main/utils/*`
- **Change**: удалить `launchTelegram`, `launchDiscord`, `useService`, `bundlePath`, стабы `needsFirstRunAdmin`/`restartAsAdmin`, неиспользуемые theme-хелперы; `maxLogDays` начинает использоваться в C12.
- **Accept**: typecheck и eslint зелёные; `knip` (или grep) не находит этих экспортов; бандл меньше. **Rollback**: revert по файлам.
### Q6 · Чистка зависимостей · P2 · M · deps: Q5
`package.json; pnpm-lock.yaml; patches/`
- **Change**: удалить `axios`, `crypto-js` (+types), `plist`, `pubsub-js` (+types), `nanoid`, `is-cidr`, `is-ip`, `driver.js`, `recharts`, `react-markdown`, `file-icon`, `file-icon-info`, `cmdk`, `@dnd-kit/*`, `monaco-yaml`, `react-monaco-editor`, `vite-plugin-monaco-editor`; удалить `patches/vite-plugin-monaco-editor@1.1.0.patch` и `pnpm.patchedDependencies`.
- **Accept**: `pnpm install --frozen-lockfile` без ошибок; build/typecheck/tests зелёные; размер `out/renderer` сократился. **Rollback**: вернуть пакеты одним revert package.json + lockfile.
### Q7 · Разделить `lint` и `lint:fix` · P2 · S · deps: T0.4
`package.json; .github/workflows/ci.yml`
- **Change**: `lint` без `--fix`, новый `lint:fix`; CI вызывает `pnpm lint`.
- **Accept**: намеренное предупреждение валит CI; локально `pnpm lint:fix` исправляет. **Rollback**: revert.
### Q8 · Пере-регистрация глобальных шорткатов · P2 · S · deps: Q4
`src/main/resolve/shortcut.ts; config/app.ts (side effects после patch)`
- **Change**: единая `applyShortcuts(config)` при старте и при изменении конфига/пересоздании окна; `globalShortcut.unregisterAll()` перед регистрацией.
- **Accept**: смена шортката в настройках работает без перезапуска; в логе нет "already registered". **Rollback**: revert.

---

## Фаза 4: Релиз и документация
### R1 · CHANGELOG 1.5.0 · P0 · S · deps: все P0/P1
`CHANGELOG.md`
- **Change**: секция `## 1.5.0` в формате 1.4.0: "Безопасность" (digest, доверие IPC, preload, prototype pollution, редакция секретов), "Исправлено" (hosts-лок, restart, lifecycle, hosts-state), "Изменено" (обновления по тегу), "Обновление: настройки сохраняются".
- **Accept**: текст попадает в GitHub Release через `release.yml`; NUL-байт нет. **Rollback**: n/a.
### R2 · Bump 1.4.0 -> 1.5.0 и тег · P0 · S · deps: R1 + зелёный CI
`package.json; scripts/version-bump.mjs`
- **Change**: minor-bump (security release), коммит `chore(release): 1.5.0`, тег `v1.5.0` после зелёного CI на `main`.
- **Accept**: тег указывает на коммит с зелёным CI; артефакты собраны с версией 1.5.0; `SHA256SUMS` и `release.json` согласованы (C10). **Rollback**: удалить тег до публикации.
### R3 · Документация безопасности · P1 · S · deps: S1-S9
`new: SECURITY.md; docs/ARCHITECTURE.md (раздел Trust boundaries); README.md`
- **Change**: модель угроз: зеркала только для ассетов, digest обязателен, IPC allow-list, env-оверрайды только в dev, поведение при отсутствии digest у GitHub.
- **Accept**: в SECURITY.md есть канал репорта и перечень гарантий; ссылки из README валидны. **Rollback**: n/a.
### R4 · Прогон матрицы верификации · P0 · M · deps: R1-R3
`docs/manual-smoke.md; артефакты в PR`
- **Change**: выполнить таблицу ниже, приложить логи и скриншоты, подписать чеклист.
- **Accept**: все строки PASS; security-reviewer и windows-platform-reviewer без замечаний. **Rollback**: блокирует релиз, а не код.

---

## Матрица верификации / Verification matrix

| # | Шаг | Команда | Ожидание |
|---|-----|---------|----------|
| 1 | Типы | `pnpm typecheck` | exit 0 (node + web) |
| 2 | Типы тестов | `pnpm typecheck:test` | exit 0 |
| 3 | Линт | `pnpm lint` | exit 0, без `--fix` |
| 4 | Тесты | `pnpm test -- --coverage` | все зелёные, покрытие ядра растёт |
| 5 | Сборка | `pnpm build:win` | exit 0, NSIS + portable |
| 6 | Целостность | `pnpm verify:dist` | asar offsets + sha256 бинарников |
| 7 | Ревью | security-reviewer, windows-platform-reviewer | 0 warning |

Ручной smoke (Windows 11, обычный запуск + admin-запуск):

1. hosts: включить сервис -> применить -> откатить; проверить managed-блок и backup.
2. DoH refresh при медленной сети: UI не блокируется, toggle работает, пробы отменяются.
3. Zapret: start -> stop -> 5x restart: ровно один `winws.exe`, WinDivert stop при выходе.
4. TgWs: start -> ссылка `tg://` открывается, stop -> порт свободен, в логах нет секрета.
5. Обновление: "доступна 1.5.0", установка по тегу, настройки после апдейта на месте.
6. Негатив: подменённый sha256 или отсутствующий digest -> установка отклонена с понятным текстом.
7. Автозапуск: включить/выключить, задача в Task Scheduler корректна, путь с `&`.
8. Трей: скрыть/показать, выход приложения убивает только свои процессы.

## Риски и митигации

| Риск | Митигация |
|------|-----------|
| `sandbox: true` ломает preload | S4 отдельным PR, список каналов покрыт тестом, откат одной строкой |
| GitHub не отдаёт `digest` | обязательный `SHA256SUMS`-ассет в нашем релизе; без него установка блокируется (fail-closed) |
| Зеркала недоступны в РФ | основной путь api.github.com; при недоступности обновление честно не предлагается |
| Потеря пользовательских настроек | NSIS upgrade-marker не трогаем, smoke-пункт 5 в каждом релизе |
| C7 (PID) усложняет kill | fallback по имени с проверкой пути, лог pid -> path |

## Дополнения после Фазы 2 (аудит)

Аудит нашёл пути эскалации, не требующие компрометации renderer. Они выполняются
**до** S4: приложение запущено с правами администратора и исполняет код из мест,
куда может писать любой процесс пользователя.

### SA1 · Не доверять кешу обновлений как источнику установки · P0 · M
`src/main/utils/update-cache.ts; src/main/core/app-updater.ts (135-168, 285-344); test/update-cache.test.ts`
- **Change**: на диск сохранять только `{ tag, publishedAt }`; `assetUrl/digest/size/hasUpdate` в кеше не хранить. Установка всегда заново резолвит ассет по тегу через `api.github.com` (S3). `at` клампится к `Date.now()`.
- **Accept**: подменённый `update-cache-app.json` не может изменить URL/дайджест; юнит-тест: кеш с чужим `assetUrl` игнорируется. **Rollback**: revert.

### SA2 · Не исполнять код из user-writable мест · P0 · L
`src/main/utils/dirs.ts (118-145); src/main/core/tgws.ts (220); src/main/core/zapret.ts (73-225, 436-490); resources/binaries.sha256 (new); scripts/verify-dist.mjs; build/nsis/installer.nsh`
- **Change**: (1) удалить `tgws.binaryPath` из `AppConfig` — всегда `tgwsBinaryPath()`; (2) `zapretBundleDir()`/`tgwsBinaryPath()` используют `runtime/` только если файл прошёл проверку по манифесту `resources/binaries.sha256`; иначе — bundled `resources/`; (3) `installZapretBundle` пишет в `runtime/` и сразу сверяет хеши `winws.exe`, `WinDivert64.sys`, `TgWsProxy_windows.exe`, `general*.bat`, `test zapret.ps1`; (4) `verify-dist` проверяет манифест; (5) NSIS ставит ACL на `runtime/` (Administrators/SYSTEM write, Users read).
- **Accept**: подмена байта в `runtime/tgws/TgWsProxy_windows.exe` → старт отклонён с понятной ошибкой; `tgws.binaryPath` в YAML игнорируется; собранное приложение проходит `verify:dist`. **Rollback**: манифест можно понизить до warn через dev-env.

### CA1 · Пробрасывать код elevated-процесса · P1 · S
`src/main/utils/elevated.ts (42-66); test/elevated-args.test.ts`
- **Change**: `Start-Process … -PassThru -Wait; exit $p.ExitCode`; вернуть stdout/stderr; отличать «UAC отменён» от «копирование не удалось».
- **Accept**: юнит-тест на сборку команды; ручной тест: отмена UAC → `ok:false`, причина «UAC отменён».

### CA2 · Uninstaller не трогает чужие профили · P1 · M
`build/nsis/installer.nsh (119-157)`
- **Change**: удалить `user_loop` по `C:\Users\*`; чистить только `SetShellVarContext current`; не следовать reparse points; при `perMachine` — чекбокс «удалить данные всех пользователей» на отдельной странице.
- **Accept**: удаление на мультиюзерной машине сохраняет второй профиль; junction не разыменовывается.

### CA3 · Relaunch с cleanup · P1 · S
`src/main/utils/ipc.ts (416-419); src/main/index.ts`
- **Change**: `app:relaunch` → `app.quit()` с ожиданием `cleanupRan`, затем `app.relaunch()` + `app.exit(0)` в `will-quit`.
- **Accept**: после «Перезапустить» ровно один `winws.exe`, порт 1443 свободен до старта нового экземпляра.

### CA4 · Разклинить Zapret после 7-секундного таймаута · P1 · S
`src/main/core/zapret.ts (564-569)`
- **Change**: в ветке таймаута `await killWinws(); child = null;` и не подавлять exit-событие.
- **Accept**: после ошибки повторный Start реально стартует; статус не залипает.

### CA5 · Отменяемый и неблокирующий тест стратегий · P1 · M
`src/main/core/zapret-tester.ts (241-357); src/main/utils/ipc.ts`
- **Change**: лок на стратегию (или отдельный `testerLock`), `AbortController`, канал `zapret:cancelStrategyTest`, общий дедлайн, прогресс в UI.
- **Accept**: Start/Stop отвечают во время теста; отмена возвращает исходную стратегию.

### CA6 · Реальный portable-режим · P1 · S
`src/main/utils/dirs.ts (8-17); electron-builder.yml (86-90)`
- **Change**: `isPortable()` = `existsSync(PORTABLE) || !existsSync(join(exeDir(),'Uninstall SkipNet.exe'))`; 7z-сборка кладёт `PORTABLE`.
- **Accept**: распакованный 7z хранит данные рядом с exe; апдейт portable отклоняется с понятным текстом.

### CA7 · Ретраи rename под AV · P1 · S
`src/main/config/app.ts (18-43); src/main/core/hosts-state.ts (170-189)`
- **Change**: 5×100 мс на `EPERM|EACCES|EBUSY`; `saveHostsState` до записи hosts.
- **Accept**: тест с подменённым `rename`, падающим первые 2 раза; состояние не теряется.

### CA8 · Атомарная запись hosts · P1 · S
`src/main/core/hosts-file.ts (94-98)`
- **Change**: temp `hosts.skipnet-<uuid>.tmp` + `fsync` + `rename` в том же каталоге; truncate-запись только как fallback.
- **Accept**: прерывание записи не оставляет обрезанный файл; `verify` зелёный.

### CA9 · TgWs update: сначала скачать и проверить · P1 · S
`src/main/core/tgws-updater.ts (208-251)`
- **Change**: download+verify → stop → `wx` write → rename; при ошибке после stop — restart предыдущего бинарника.
- **Accept**: заблокированная загрузка не выключает прокси; тест на порядок вызовов.

### CA10 · Убрать синхронные блокировки main · P1 · M
`src/main/core/hosts-file.ts (141-161); src/main/core/wallpaper.ts (334-381); src/main/utils/ipc.ts (394)`
- **Change**: `flushDns` через `execFile`; `wallpaperListWorkshop(force=false)` по умолчанию; скан через `fs.promises`/worker.
- **Accept**: IPC не блокируется > 200 мс; кеш 20 с используется.

### Приоритет выполнения

`T0.*` → **SA1 → SA2** → S1 → S2 → S3 → S8 → S6 → S7 → S4 → S5 → S9 → CA1 → CA2 → CA3 → C3 → C5 → C4 → C2 → C1 → CA4 → CA5 → C7 → C8 → C9 → C10 → C11 → C12 → CA6-CA10` → Q1-Q8 → R1-R4.

## Известные non-goals

- Миграция на `electron-updater` / autoUpdater: нет.
- Подпись кода (EV-сертификат) и SmartScreen-репутация: отдельный трек.
- Переписывание `hosts-render.ts` / `hosts-editor.ts`, пайплайна конфига, медиа-протокола: нет.
- macOS/Linux-паритет, i18n, крупные мажорные апгрейды зависимостей: нет.
- Полная замена DoH/TLS-логики и стратегий Zapret: нет.

## Definition of Done (соответствие)

- [ ] `pnpm build:win` -> 0 (шаг 5).
- [ ] `pnpm test` зелёный, `typecheck` и `lint` без ошибок (шаги 1-4).
- [ ] security-reviewer и windows-platform-reviewer: 0 замечаний (шаг 7).
- [ ] CHANGELOG 1.5.0 готов, тег `v1.5.0` после зелёного CI (R1-R2).
