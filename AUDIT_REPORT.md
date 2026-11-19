# Audit Report — SkipNet 1.4.0 (Фаза 2)

Дата: 2026-11-20 · HEAD `77360d8` · v1.4.0 · дерево чистое на старте аудита.
Метод: четыре независимых read-only ревью (`security-reviewer`, `electron-pro`,
`windows-platform-reviewer`, `react-19-pro`) + выборочная проверка находок по коду.
Ни один файл исходников в ходе аудита не изменялся.

## Сводка

| Зона | Critical | High | Medium | Low |
|---|---:|---:|---:|---:|
| Безопасность (security) | 3 | 4 | 8 | 5 |
| Main / preload / IPC | 6 | 13 | 14 | 12 |
| Windows / установщик | 1 | 4 | 13 | 9 |
| Renderer | 0 | 3 | 7 | 14 |

Часть находок пересекается. Ниже — объединённый список без дублей.

## P0 — блокеры релиза 1.5.0

| # | Проблема | Доказательство | Риск | Задача |
|---|---|---|---|---|
| P0-1 | Проверка обновлений **fail-open**: нет digest → установка продолжается; `sha512:`/мусор игнорируется | `app-updater.ts:263-277`, `zapret-updater.ts:192-198`, `tgws-updater.ts:245-251` | Подмена установщика → код с правами администратора | S1 |
| P0-2 | Метаданные релиза тянутся через сторонние зеркала `gh-proxy.com`/`ghfast.top` | `utils/github.ts:16-33` | Зеркало подсовывает свой JSON и свой digest | S2 |
| P0-3 | Renderer сам передаёт `url` + `digest` + `size` установщика | `ipc.ts:278-305, 404-411` | Любой XSS/компрометация renderer → Elevated RCE | S3 |
| P0-4 | **Кеш обновлений доверенный**: user-writable JSON задаёт `assetUrl`/`digest`/`hasUpdate`/`at` | `utils/update-cache.ts:22-33`, `app-updater.ts:135-168` | Один клик по фальшивому баннеру → Elevated RCE. S3 сам по себе это не закрывает | **SA1 (нов.)** |
| P0-5 | **Запуск бинарников из user-writable мест**: `%APPDATA%\skipnet\runtime\{zapret,tgws}` и `tgws.binaryPath` из `config.yaml` | `dirs.ts:126-145`, `tgws.ts:220`, `zapret.ts:436-490` | Medium-IL процесс подменяет `winws.exe`/`TgWsProxy`/`general.bat` → Elevated RCE, обход UAC | **SA2 (нов.)** |
| P0-6 | `zapret:installBundle` принимает ZIP из renderer и исполняет его Elevated; вызовов из UI нет | `ipc.ts:294-296`, `zapret.ts:73-225` | Renderer → Elevated RCE без диалога | S8 |
| P0-7 | Preload отдаёт весь `electronAPI` (raw `ipcRenderer`, `process.env`, `webFrame`), `sandbox:false` | `preload/index.ts:14`, `main/index.ts:276` | Снимает второй барьер со всех уязвимостей выше | S4 |
| P0-8 | `isTrustedSender` доверяет любому `file://`; навигационный guard сравнивает `origin === "null"` и не работает | `ipc.ts:229-237`, `index.ts:361-373` | Открытие локального HTML в окне → полный IPC | S5 |
| P0-9 | `deepMerge` + `app:patchConfig` без валидации: prototype pollution и произвольные ключи конфига | `utils/merge.ts:13-31`, `ipc.ts:260` | Загрязнение `Object.prototype` в Elevated-процессе; `binaryPath` = RCE | S6, S7 |
| P0-10 | Полный `--secret` TgWsProxy пишется в логи и транслируется в renderer | `tgws.ts:233,267` | Утечка ключа прокси и всех `tg://`-ссылок | S9 |

## P1 — исправить в 1.5.0, если успеваем; иначе 1.5.1

| # | Проблема | Доказательство | Последствие | Задача |
|---|---|---|---|---|
| P1-1 | `runPowerShellElevated` возвращает код **лаунчера**, а не elevated-процесса (`Start-Process -Wait` без `-PassThru`) | `utils/elevated.ts:42-66` | Неудачная запись hosts считается успешной; ложное «проверка не совпала» | **CA1 (нов.)** |
| P1-2 | Uninstaller удаляет `%APPDATA%\skipnet` **всех** профилей `C:\Users\*`, следует junction’ам | `build/nsis/installer.nsh:119-157` | Потеря настроек и секретов других пользователей | **CA2 (нов.)** |
| P1-3 | `app:relaunch` → `app.exit(0)` без cleanup | `ipc.ts:416-419` | Осиротевший `winws.exe`, занятый порт 1443 | **CA3 (нов.)** |
| P1-4 | `withHostsLock` держится на TCP-пробах, `flushDns` (`spawnSync`, до 10 с) и DoH (до 300 с) | `hosts-editor.ts:80-84, 396, 453, 672-749` | Страница hosts зависает на минуты | C1 |
| P1-5 | `restart()` = stop + start в двух разных локах | `zapret.ts:239-244,594-598`, `tgws.ts:204-209,369-375` | Дубли/потеря процессов | C2 |
| P1-6 | Single-instance без early return; updater делает `process.exit` в обход cleanup | `index.ts:42-45`, `app-updater.ts:532-539` | Второй экземпляр пишет конфиг; сервисы не останавливаются | C3 |
| P1-7 | Битый `hosts-state.json` → «всё выключено», файл hosts не тронут | `hosts-state.ts:156-167` | Потеря выбора сервисов | C4 |
| P1-8 | XML Task Scheduler без экранирования; путь с `&` ломает автозапуск | `autoRun.ts:54-102` | Автозапуск молча не работает | C5 |
| P1-9 | `SKIPNET_*` env-оверрайды действуют в production | `app-updater.ts:17-28,329`, `hosts-catalog.ts:394`, `zapret-lists.ts:39` | Перехват обновлений переменной окружения | C6 |
| P1-10 | Убийство процессов по имени образа (`winws.exe`, `TgWsProxy`) | `zapret.ts:247-253`, `tgws.ts:94-114`, `index.ts:183-203` | Ломает чужие установки Zapret/TgWs | C7 |
| P1-11 | `openHostsFile` открывает Блокнот из Elevated-процесса | `hosts-editor.ts:823-827` | Скрытая запись hosts с админ-правами | C8 |
| P1-12 | Диагностика `sc delete` чужих служб и `taskkill Discord.exe` без подтверждения | `zapret-diagnostics.ts:130,462-483,556-587` | Разрушение чужой установки/данных | C9 |
| P1-13 | Нет манифеста хешей `winws.exe` / `WinDivert64.sys` / `TgWsProxy_windows.exe`; `verify-dist` проверяет только наличие | `verify-dist.mjs:155-157` | Подмена бинарников не детектируется | C10 |
| P1-14 | CSP разрешает `file:` для img/media; `bypassCSP:true` у `skipnet-media://` | `index.html:9`, `wallpaper.ts:110-121` | Потеря second line of defence | C11 |
| P1-15 | Логи не пишутся на диск; `maxLogDays` не используется | `app-logger.ts:9-19`, `dirs.ts:108-116` | Невозможно диагностировать сбой | C12 |
| P1-16 | После 7-секундного таймаута `child` не обнуляется → следующий Start — no-op | `zapret.ts:564-569` | Зависшее состояние Zapret | **CA4 (нов.)** |
| P1-17 | Strategy tester держит `withZapretLock` 4–6 минут без отмены | `zapret-tester.ts:241-357` | UI Start/Stop «висит» | **CA5 (нов.)** |
| P1-18 | `isPortable()` требует файл `PORTABLE`, которого сборка не создаёт | `dirs.ts:8-17`, `electron-builder.yml:86-90` | Portable-версия ставится вторым экземпляром в Program Files | **CA6 (нов.)** |
| P1-19 | `rename` без ретраев на `EPERM/EBUSY` (AV/бэкап держит файл) | `config/app.ts:18-43`, `hosts-state.ts:170-189` | «Настройки не сохраняются» на машинах с AV | **CA7 (нов.)** |
| P1-20 | Запись hosts через `writeFileSync` (O_TRUNC) вместо temp+rename | `hosts-file.ts:94-98` | Обрыв записи оставляет обрезанный hosts | **CA8 (нов.)** |
| P1-21 | TgWs update сначала останавливает прокси, потом скачивает; ошибка оставляет прокси выключенным | `tgws-updater.ts:208-251` | Telegram без прокси после неудачного апдейта | **CA9 (нов.)** |
| P1-22 | `hosts:flushDns` и `wallpaper:listWorkshop` синхронно блокируют main | `hosts-file.ts:141-161`, `wallpaper.ts:334-381`, `ipc.ts:394` | Замирание окна и IPC | CA10 (нов.) |

## P2 — renderer и качество (Фаза 3.4)

- `patchAppConfig` глотает ошибку и резолвится успешно → ложные «сохранено» (`use-app-config.tsx:17-25`), вплоть до смены секрета TgWs.
- Патчи конфига отправляют целые вложенные объекты (`{...appConfig.tgws}`) → затирание параллельных изменений.
- Четыре независимых некэшированных `checkUpdate` → исчерпание GitHub API 60/ч; Home игнорирует `zapret.checkUpdates`.
- Hosts RPC возвращают весь каталог (226 КБ) на каждую операцию → полный ре-рендер 107 карточек.
- Проглоченные ошибки старта/остановки на страницах Telegram/Zapret; fire-and-forget IPC без `.catch`.
- A11y: `Label` без `htmlFor`, switch без `aria-label`, update-overlay без `role="dialog"`/focus trap/Esc.
- Поиск по hosts перерисовывает всё синхронно; `matches` вне зависимостей `useMemo`.
- Дубли: `compareVersion` ×4, `broadcast()` ×4, update-banner ×3; циклические импорты через barrel `main/index.ts`.
- Мёртвый код и зависимости: `zapret:installBundle`, стабы `needsFirstRunAdmin`/`restartAsAdmin`, `launchTelegram/launchDiscord`, `useService`, `bundlePath`, `latest.yml`, ~20 неиспользуемых devDependencies, monaco-патч.
- `lint` с `--fix` в package-скрипте; нет `eslint-plugin-react-hooks`.

## Подтверждённые сильные места — не менять

- Пайплайн записи hosts: backup → запись → перечитывание → hash-сверка → rollback (`hosts-editor.ts:429-452`).
- Elevated-запись через `-EncodedCommand` + SHA-256 внутри elevated-скрипта (`hosts-file.ts:99-121`).
- Атомарная запись конфига: `wx` + random temp + backup + `rename` (`config/app.ts:18-43`).
- `hosts-render.ts`: чистый модуль без Electron/FS, сбалансированные блоки, BOM/CRLF-устойчивость.
- Каталог hosts: строгая схема, лимиты, «удалённый каталог может менять только известные хосты».
- `skipnet-media://`: allow-list + расширения + containment для Workshop `project.json`.
- Zapret: basename allow-list стратегий, staging-swap с rollback, отказ от `sc delete` WinDivert при выходе.
- CSP без `unsafe-eval`, без `dangerouslySetInnerHTML`; `setWindowOpenHandler` → deny.
- NSIS upgrade-marker + `customInstall`; `verify-dist` проверяет asar-смещения и отсутствие `.log`.

## Готовность к Фазе 3

Порядок работ изменён относительно исходного плана: **SA1–SA2 (исполнение из user-writable мест и доверие кешу) идут раньше preload/sandbox**, потому что они не требуют компрометации renderer и дают прямой обход UAC.

Definition of Done остаётся: `pnpm typecheck`, `pnpm lint`, `pnpm test`, `pnpm build:win`, `pnpm verify:dist`, 0 замечаний security/windows-ревью, CHANGELOG 1.5.0.
