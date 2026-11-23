# Архитектура SkipNet

**Обновлено:** 2026-11-20 · **Версия:** 1.5.0

Документ описывает устройство процессов, IPC-контракт, владение состоянием,
потоки обновления и hosts, наблюдение за процессами, логирование и тесты.
Модель угроз и гарантии — в [SECURITY.md](../SECURITY.md).

## Карта процессов

| Процесс | Точка входа | Ответственность | Права |
| :--- | :--- | :--- | :--- |
| **main** | `src/main/index.ts` | Конфиг, hosts, обновления, запуск компонентов, трей, автозапуск, окно, IPC | Администратор: манифест `requestedExecutionLevel: requireAdministrator` |
| **preload** | `src/preload/index.ts` | Узкий мост `window.skipnet` (`invoke`, `on`, `platform`) | Изолированный мир, `sandbox: true` |
| **renderer** | `src/renderer/` | React-интерфейс, Zustand-сторы, локализация, темы | Chromium, без Node.js и без прямого IPC |
| **shared** | `src/shared/` | Реестр каналов, общие типы, версии, типы логов | Код, импортируемый обеими сторонами |

```text
┌──────────────────────────────────────┐
│ renderer (Chromium, sandbox)         │
│ React · Zustand · i18n               │
└──────────────────┬───────────────────┘
                   │ window.skipnet.invoke / on
┌──────────────────▼───────────────────┐
│ preload (isolated world)             │
│ allow-list каналов из shared         │
└──────────────────┬───────────────────┘
                   │ ipcRenderer
┌──────────────────▼───────────────────┐        ┌────────────────────────────┐
│ main (elevated)                      │───────▶│ resources/                 │
│ config · hosts · updaters · process  │        │ zapret · tgws · манифест   │
└──────┬──────────────────────┬────────┘        │ ACL: admin-only            │
       │                      │                 └────────────────────────────┘
       ▼                      ▼
  winws.exe            TgWsProxy_windows.exe
  (cmd /c стратегия)   (--secret …)
```

## IPC-контракт

- **Конверт.** Каждый `ipcMain.handle` возвращает `{ ok: true, value }` либо
  `{ ok: false, message }`. Исключения не пересекают границу процесса: они
  сериализуются в `message`, а в лог пишется `{ channel, message, stack }`.
- **Реестр каналов.** `src/shared/ipc-channels.ts` содержит frozen-списки
  `INVOKE_CHANNELS` и `EVENT_CHANNELS`; `isInvokeChannel`/`isEventChannel`
  проверяют значение. `EVENT_CHANNELS` — только push-каналы main → renderer,
  их нельзя вызвать; invoke-каналы нельзя слушать.
- **Компиляторная полнота.** `registerIpcMainHandlers` типизирует карту как
  `Record<InvokeChannel, IpcHandler>`, поэтому канал, добавленный в реестр без
  обработчика (или наоборот), ломает `pnpm typecheck`.
- **Preload allow-list.** `window.skipnet.invoke` отклоняет канал вне
  `INVOKE_CHANNELS`; `on` игнорирует канал вне `EVENT_CHANNELS` и снимает
  только свой listener. Сырого `ipcRenderer`, `process.env` и `webFrame` в
  renderer нет.
- **Доверие отправителю.** `isTrustedSender` требует:
  1. существующий `event.senderFrame`;
  2. `frame === event.sender.mainFrame` (вложенные iframe/webview отсекаются);
  3. `isTrustedFrameUrl`: точный путь `out/renderer/index.html` для `file://`
     либо точный origin `ELECTRON_RENDERER_URL` в dev. `about:`, `data:`,
     `blob:` и любой другой файл/Origin отклоняются. В собранной сборке
     `ELECTRON_RENDERER_URL` игнорируется.
- **Навигация.** `setWindowOpenHandler` запрещает новые окна, `will-navigate`
  пропускает только доверенный URL.

Каналы сгруппированы по префиксам: `app:*`, `theme:*`, `tgws:*`, `zapret:*`,
`hosts:*`, `wallpaper:*`, `window*`. Полный список — в
`src/shared/ipc-channels.ts`; он является единственным источником истины.

## Владение состоянием

| Состояние | Где хранится | Кто пишет | Примечание |
| :--- | :--- | :--- | :--- |
| `config.yaml` | `%APPDATA%\skipnet` (portable: `<exe>\data`) | `src/main/config/app.ts` | Атомарно: temp `wx` → backup → rename; схема до merge |
| `hosts-state.json` | Тот же профиль | `core/hosts-state.ts`, `core/hosts-editor.ts` | Сохраняется до записи hosts; битый файл восстанавливается по managed-блоку |
| Системный `hosts` | `C:\Windows\System32\drivers\etc\hosts` | `core/hosts-file.ts` (elevated helper) | Managed-блок между маркерами; чужие строки не меняются |
| Бэкапы hosts | `<профиль>\hosts-backups` | `core/hosts-editor.ts` | `hosts-<stamp>.bak` + `state-<stamp>.json`, до 20 |
| Статус TgWs/Zapret | Память main-процесса | `core/tgws.ts`, `core/zapret.ts` | Отдаётся через `*:getStatus` и push-события |
| Отслеживаемые процессы | Память main-процесса | `core/process-ownership.ts` | `{ pid, imagePath, startedAt, component }` |
| UI-состояние | Renderer (Zustand) | Renderer | Проекция состояния main; не источник истины |
| Кеш обновлений | `<профиль>\update-cache-*.json` | `utils/update-cache.ts` | Только тег, версия, флаг, заметки и время; URL/дайджест не хранятся |
| Логи | `<профиль>\logs\app-YYYY-MM-DD.log` | `utils/app-logger.ts` | JSONL, ротация и prune |

## Поток обновления приложения

1. **Проверка.** `checkAppUpdate` запрашивает последний релиз через
   `fetchGithubApi` (единственный источник — `api.github.com`), сравнивает
   версии и сохраняет в кеш только отображаемые поля и время проверки.
2. **Выбор.** Пользователь видит тег и нажимает «Установить»; renderer передаёт
   **только тег**. `assertExpectedReleaseTag` требует, чтобы тег совпадал с
   последним проверенным релизом.
3. **Повторный резолв.** `installAppUpdate(tag)` заново запрашивает релиз по
   тегу через API, запрещает downgrade относительно установленной версии,
   выбирает ассет по allow-list (`SkipNet_x64.exe`) и берёт `digest` из ответа
   API либо из `SHA256SUMS.txt` того же релиза, скачанного напрямую
   (`fetchReleaseAssetDirect`).
4. **Загрузка и проверка.** `fetchReleaseAsset` качает с `github.com`; зеркала
   используются только как fallback для байтов ассета. `verifyAsset` проверяет
   размер, нижнюю границу и sha256; любое расхождение — отказ.
5. **Staging.** Установщик пишется в `%ProgramData%\SkipNet\updates`
   (`secureStagingDir`, ACL Administrators/SYSTEM) с флагом `wx`.
6. **Проверка перед запуском.** Main останавливает TgWs и Zapret, перечитывает
   файл из staging и **повторно** проверяет размер и sha256, затем пишет
   upgrade-marker и запускает установщик в тихом режиме (`/S --updated`).
   Приложение завершается; watcher возвращает SkipNet после установки.
7. **Установка.** NSIS заменяет файлы, сохраняет профиль и перезапускает
   приложение. Portable-сборка обновление отклоняет: у неё нет uninstaller и
   второе развёртывание создало бы независимую копию.

### Обновление компонентов

- **Zapret.** ZIP скачивается и проверяется тем же `verifyAsset`. Затем
  `installZapretArchive` останавливает `winws.exe`, снимает службы WinDivert,
  распаковывает архив в sibling-каталог `resources/zapret.staging-<uuid>`,
  меняет каталоги местами и пересчитывает `resources/binaries.sha256` через
  `updateManifestEntries`. После этого `verifyZapretBundle` проверяет каждый
  исполняемый файл; при ошибке старый бандл и манифест возвращаются.
- **TgWsProxy.** Бинарник скачивается, проверяется (digest + MZ-заголовок),
  прокси останавливается, файл пишется во временный `wx`-файл, старый
  отводится в `.previous`, новый переименовывается на место. Манифест
  обновляется и `verifyTgwsBinary` подтверждает байты; при сбое — откат.
  Renderer перезапускает прокси, если тот работал до обновления.

Общий инвариант: **ни один исполняемый файл не запускается без записи в
`binaries.sha256` и успешной проверки**.

## Пайплайн hosts

```text
каталог → выбор в state → проверка адресов → план → бэкап → state
        → сборка блока → атомарная запись → сверка хеша → откат при ошибке
```

1. **Каталог.** `resources/hosts-catalog.json`; скачанный каталог проходит
   строгую валидацию (`validateHostsCatalog`): схема, id, hostname, IP,
   отсутствие управляющих символов.
2. **Выбор.** `hosts-state.json` хранит выбранные сервисы, DNS-профили,
   `skippedIps`, `renderedHash` и время резолва.
3. **Проверка.** `refreshHostsAddresses` опрашивает системный DNS и DoH
   (Google, Cloudflare, AdGuard), затем проверяет кандидатов TLS-рукопожатием
   с SNI нужного домена. Мёртвые адреса попадают в `skippedIps` и не пишутся.
4. **План.** `hosts-render.ts` строит managed-блок только из выбранных сервисов
   и живых адресов; чужие строки файла сохраняются байт-в-байт.
5. **Бэкап и state.** Перед мутацией создаётся `hosts-<stamp>.bak` и
   `state-<stamp>.json`; `saveHostsState` вызывается **до** записи hosts.
6. **Запись.** `hosts-file.ts` пишет temp-файл в том же каталоге, делает
   `fsync`, затем `rename`; при `EPERM`/`EACCES`/`EBUSY` — до пяти повторов.
7. **Сверка и откат.** Файл перечитывается, сравнивается `hashHostsContent`;
   при расхождении возвращается исходное содержимое и показывается ошибка.
   UTF-16 `hosts` отклоняется с объяснением.

### Модель блокировок

- `withStateLock` — **короткая** блокировка: чтение state, план, бэкап, запись
  hosts и state. Она не держится во время сетевых проб.
- Пробы (`probeIps`, `resolveHosts`, DoH, TLS) выполняются **вне** лока.
  Refresh снимает снимок state, отпускает лок, проверяет адреса, затем снова
  берёт лок и проверяет, что снимок не устарел.
- `AbortController` отменяет пробы при действии пользователя и при выходе;
  общий дедлайн refresh — 120 с. Таймаут не перезаписывает hosts пустым блоком.
- Переключатель сервиса не ждёт проб: он применяет выбор и возвращает
  `refreshing: true`, если обновление ещё идёт.

## Наблюдение за процессами

- Каждый spawn регистрируется в `process-ownership.ts` с PID, путём образа и
  временем старта; запись снимается при выходе процесса.
- `process-kill.ts` перечисляет процессы через CIM/tasklist и проверяет, что
  путь образа лежит внутри `resources/`. Kill выполняется
  `taskkill /F /T /PID <pid>`; kill по имени — только fallback, если путь
  подтверждает владение.
- Выход приложения (`before-quit` → `will-quit` → `exit`) идемпотентно
  останавливает сервисы, убивает свои процессы и снимает драйвер WinDivert.
  Чужие `winws.exe`/`TgWsProxy_windows.exe` не затрагиваются.
- **Zapret.** Preflight BFE → проверка манифеста бандла → `cmd /c <стратегия>`
  → 7-секундное окно здоровья по выводу `winws.exe` (WinDivert loaded/failed).
  Таймаут убивает процесс и обнуляет ссылку, поэтому следующий Start работает.
  `restart()` держит один operation-lock на stop → start.
- **Тест стратегий.** `zapret-tester.ts` — нативный порт проверок из
  `utils/test zapret.ps1`: цели читаются из `utils/targets.txt` (fallback —
  встроенный список), каждый URL проверяется `curl.exe` в режимах HTTP/1.1,
  TLS 1.2 и TLS 1.3, затем цель пингуется 1 с. Классификация (`OK` / `ERROR` /
  `UNSUP` / `SSL`) и аналитика совпадают с консольным отчётом; лучшая
  стратегия — максимум HTTP OK, при равенстве — максимум ping OK. Пробы идут
  параллельно (`min(16, max(8, cpus × 2))`). Lock берётся только на stop/spawn,
  прогон отменяем, при отмене/пре-емпте прежняя стратегия восстанавливается, а
  отчёт с `mode: 'standard'` пишется в `%APPDATA%`.
- **TgWs.** Проверка/генерация секрета → проверка порта → spawn
  `TgWsProxy_windows.exe` с аргументами → отслеживание PID. Stop освобождает
  только свой PID и порт.

## Логирование

- `appLog(type, payload)` — единая точка выхода. Строка проходит через
  `redactSecrets` (маскируются `--secret`, `secret=`, `tg://…secret=` и
  32-hex-токены, включая точный текущий секрет) и только затем уходит в
  renderer и на диск.
- Файл — JSONL, одна запись на строку, один файл в день
  (`app-YYYY-MM-DD.log`). При 5 МБ активный файл переименовывается в `.1`;
  файлы старше `maxLogDays` (по умолчанию 7) удаляются на старте.
- Запись сериализована очередью, поэтому параллельные события не рвут строки.
  Ошибки логирования не блокируют приложение.

## Тесты и точки расширения

| Уровень | Где | Команда | Что покрывает |
| :--- | :--- | :--- | :--- |
| Unit | `test/*.test.ts` | `pnpm test` | Чистая логика: hosts-render, merge, схема, update-integrity, IPC-trust, redact, process ownership, staging |
| Types | `test/**/*.ts` | `pnpm typecheck:test` | Тесты и main-модули без Electron |
| E2E | `test-e2e/app.spec.ts` | `pnpm test:e2e` | Реальный `out/main/index.js` в Playwright Electron: навигация, консольные ошибки, каталог hosts |

- Unit-тесты не требуют admin-прав, сети и реестра: `vitest.config.ts`
  подменяет `electron` на `test/setup/electron-mock.ts`, все пути — во
  временном каталоге.
- E2E запускается **только локально**; CI (`ci.yml`) его не выполняет.
  `test-e2e/electron-main.cjs` отключает OS-интеграцию (протоколы, `schtasks`,
  `reg`, службы, `taskkill`), поэтому тест не меняет систему.
- Новую чистую логику добавляйте в `test/*.test.ts`; проверку реального
  поведения Windows (hosts, UAC, автозапуск, деинсталляция) — в
  [manual-smoke.md](./manual-smoke.md); новые пользовательские потоки — в
  `test-e2e/app.spec.ts`, если они не требуют admin-прав.

## Границы доверия

```text
┌──────────────────── Недоверенная зона ─────────────────────┐
│ renderer: загруженный HTML, ответы сети, Zustand-стор      │
└───────────────────────────┬────────────────────────────────┘
                            │ allow-list каналов + exact frame
┌───────────────────────────▼────────────────────────────────┐
│ preload: только invoke/on по frozen-списку                 │
└───────────────────────────┬────────────────────────────────┘
                            │ IPC + конверт { ok, value }
┌───────────────────────────▼────────────────────────────────┐
│ main (elevated): схема, манифест, staging, spawn, процессы │
└───────┬───────────────────────────────┬────────────────────┘
        │                               │
┌───────▼──────────────────┐   ┌────────▼─────────────────────┐
│ resources/ (ACL)         │   │ %ProgramData%\SkipNet (ACL)  │
│ payload + binaries.sha256│   │ staging установщика          │
└───────┬──────────────────┘   └──────────────────────────────┘
        │
┌───────▼────────────────────────────────────────────────────┐
│ Сеть: api.github.com (метаданные) · github.com (ассеты)    │
│ зеркала (только байты) · DoH · каталог списков             │
└────────────────────────────────────────────────────────────┘

Вне границы доверия для исполняемого кода:
%APPDATA%\skipnet, %TEMP%, portable-каталог, системный hosts
```

Профиль пользователя (`%APPDATA%\skipnet`) доступен на запись тому же
пользователю. Поэтому оттуда не запускаются бинарники и не берутся URL,
дайджесты или размеры обновлений — только инертное состояние и отображаемые
данные.
