# Code Deletion Log

## [2026-11-20] Refactor session Q1-Q8

### Duplicate code consolidated
- `compareVersion` ×4 (`core/app-updater.ts`, `core/zapret-updater.ts`, `core/tgws-updater.ts`, `core/hosts-catalog.ts`) → `src/shared/version.ts`.
  New comparator implements SemVer precedence: prerelease below release, build metadata ignored, optional `v`, numeric segments compared numerically.
- `broadcast()` ×4 (`utils/app-logger.ts`, `core/tgws.ts`, `core/zapret.ts`, `core/zapret-tester.ts`) → `src/main/utils/broadcast.ts`.
  Single implementation skips destroyed windows and catches send errors.
- Update install banner markup/logic in `pages/telegram.tsx` and `pages/zapret.tsx` → `src/renderer/src/components/update-banner.tsx`.
  Home keeps its details-only notice (it navigates instead of installing).

### Modules extracted
- `src/main/resolve/window-ref.ts` — owns `getMainWindow`/`setMainWindow` and injects window commands, removing the `resolve/* → main/index.ts` import cycle.
- `scripts/check-main-imports.mjs` — fails if `src/main/resolve` or `src/main/config` imports `..` / `../index`; wired as `pnpm check:imports` and a CI step.

### Unused exports/fields removed
- `src/main/utils/ipc.ts` — `setupIpc()`.
- `src/main/utils/dirs.ts` — `homeDir`, `taskDir()`.
- `src/main/resolve/theme.ts` — `resolveThemes()`, `importThemes()`, `writeTheme()`.
- `src/renderer/src/utils/ipc.ts` — `needsFirstRunAdmin`, `restartAsAdmin` stubs.
- `src/renderer/src/components/logs/log-item.tsx` — unused component.
- `src/renderer/src/utils/init.ts` — mutable `version` and no-op `init()`.
- `AppConfig` — `launchTelegram`, `launchDiscord`, `zapret.useService`, `zapret.bundlePath` (type-only; the schema still explicitly rejects legacy `binaryPath`/`bundlePath` overrides).
- `HostsOperationResult` no longer carries `catalog`; mutations return `{ state, status, recovery?, message, warnings }`.

### Dependencies removed (verified with zero import matches in `src/`, `scripts/`, tests and configs)
- Runtime: `@electron-toolkit/preload`.
- Dev: `@dnd-kit/core`, `@dnd-kit/sortable`, `@dnd-kit/utilities`, `@types/crypto-js`, `@types/express`, `@types/js-yaml`, `@types/pubsub-js`, `@types/ws`, `axios`, `cmdk`, `crypto-js`, `driver.js`, `file-icon`, `file-icon-info`, `is-cidr`, `is-ip`, `js-yaml`, `monaco-yaml`, `nanoid`, `plist`, `pubsub-js`, `react-markdown`, `react-monaco-editor`, `recharts`, `tar`, `vite-plugin-monaco-editor`, `ws`.
- Deleted `patches/vite-plugin-monaco-editor@1.1.0.patch` and the `pnpm.patchedDependencies` entry.
- `pnpm-lock.yaml` regenerated (`pnpm install --frozen-lockfile` passes).

### Kept intentionally
- `clearProbeCache` — used by `test/hosts-cancellation.test.ts`.
- `customTheme` — read by `renderer/src/App.tsx` and validated by the config schema.
- `latest.yml` remains part of the release contract.
- `docs/DELETION_LOG.md` is the only documentation addition; `REFACTOR_PLAN.md` / `AUDIT_REPORT.md` are not committed.
