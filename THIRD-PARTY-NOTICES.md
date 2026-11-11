# Third-Party Notices

SkipNet is distributed under the terms of the GNU General Public License
v3.0 (see [LICENSE](./LICENSE)). It bundles, modifies and links against a
number of upstream open-source projects whose authors and licenses are
acknowledged below.

If you redistribute SkipNet (in source or binary form) you must preserve
this file together with [LICENSE](./LICENSE) and [COPYRIGHT](./COPYRIGHT).

SkipNet is maintained by **slavniynazzik**
(<https://github.com/slavniynazzik/SkipNet>).

---

## 1. Koala Clash

UI architecture, page-transition animations, several React components, the
Tailwind theme tokens and various visual primitives in SkipNet's renderer
are derived from **Koala Clash**.

- Upstream: <https://github.com/coolcoala/koala-clash>
- License: GNU General Public License v3.0 (or later)
- Copyright (C) Koala Clash contributors

Modified files in `src/renderer/` carry a header noting the modification
date and a short description of what was changed. The full text of the
GPL applies to those files exactly as it does to the rest of SkipNet.

> SkipNet's choice of GPL-3.0 as its overall license is a direct
> consequence of using Koala Clash sources: GPL is copyleft and requires
> any derivative work to be licensed under the same terms.

---

## 2. Flowseal/tg-ws-proxy (TgWsProxy)

The bundled `TgWsProxy_windows.exe` is a CLI rebuild of
**Flowseal/tg-ws-proxy** — a Telegram MTProto-over-WebSocket relay.

- Upstream source: <https://github.com/Flowseal/tg-ws-proxy>
- SkipNet's CLI rebuild mirror:
  <https://github.com/slavniynazzik/SkipNet-tgws-cli>
- License: MIT (see `resources/tgws/LICENSE.txt`)
- Copyright (C) 2026 Flowseal

The mirror exists because the official Flowseal release ships a tray-GUI
binary (entry point `windows.py` + `pystray`) that pops a first-run
dialog, parks a tray icon, ignores `--host`/`--port`/`--secret` CLI args
and acquires a single-instance mutex incompatible with SkipNet's
headless integration. The mirror rebuilds the exact same source through
PyInstaller against `proxy.tg_ws_proxy:main` (the CLI entry point),
producing a true headless `.exe` with no UI surface. No source code is
modified — only the build configuration.

---

## 3. bol-van/zapret + Flowseal/zapret-discord-youtube (Zapret bundle)

The bundled DPI-bypass strategies and `winws.exe` come from
**Flowseal/zapret-discord-youtube**, which itself bundles
**bol-van/zapret**.

- Flowseal bundle: <https://github.com/Flowseal/zapret-discord-youtube>
  - License: MIT (see `resources/zapret/LICENSE.txt`)
- Underlying engine `bol-van/zapret`: <https://github.com/bol-van/zapret>
  - License: MIT
- Copyright (C) 2016-2026 bol-van
- Copyright (C) 2024-2026 Flowseal

SkipNet redistributes the bundle verbatim, plus a small SkipNet-specific
patch applied at build time by `scripts/patch-zapret.ps1`. The patch strips
the `start ... /min` wrapper from every `general*.bat` so `winws.exe` runs as
a direct child of the hidden `cmd.exe` spawned by SkipNet instead of popping
a console window. It does not modify any upstream binary and is released
under the same MIT terms as the files it touches.

---

## 4. WinDivert

Bundled inside `resources/zapret/bin/` as `WinDivert.dll` and
`WinDivert64.sys`, used by `winws.exe` for low-level packet
interception on Windows.

- Upstream: <https://reqrypt.org/windivert.html> and
  <https://github.com/basil00/WinDivert>
- License: dual-licensed, at the user's option, under either
  - GNU Lesser General Public License v3.0 (LGPL-3.0), or
  - GNU General Public License v2.0 (GPL-2.0)
- Copyright (C) 2012-2024 basil00

SkipNet distributes WinDivert as an unmodified binary alongside
`winws.exe` under the LGPL-3.0 option. The corresponding source code and
license texts are available from the upstream project above.

---

## 5. Sparkle (Russian community fork) — historical heritage

SkipNet started life as a fork of a Russian community fork of
**Sparkle**, and has since been rewritten end-to-end. None of the
original Sparkle source survives in current SkipNet code, but the
project layout and a handful of build-side conventions trace back to
that lineage.

- Mihomo Party (closest English-language ancestor of the fork tree):
  <https://github.com/mihomo-party-org/mihomo-party>
- License: GNU General Public License v3.0
- Copyright (C) Mihomo Party contributors and Sparkle community
  contributors

---

## 6. NPM dependencies

The `package.json` lists every direct npm dependency. They are pulled
in at install time via `pnpm install`, are not redistributed in source
form by SkipNet, and are governed by their own licenses (predominantly
MIT, ISC and Apache-2.0). Notable bundled libraries:

| Project | License | Purpose |
| --- | --- | --- |
| Electron | MIT | Desktop runtime |
| React | MIT | UI framework |
| Vite | MIT | Renderer bundler |
| Tailwind CSS | MIT | Styling |
| Radix UI / shadcn-ui | MIT | UI primitives |
| Lucide | ISC | Icon set |
| Zustand | MIT | State management |
| Sonner | MIT | Toast notifications |
| adm-zip | MIT | Zapret bundle unpack |
| crypto-js | MIT | Hashing utilities |
| axios | MIT | HTTP client |
| react-router-dom | MIT | Routing |
| @electron-toolkit/* | MIT | Electron integration helpers |

Run `pnpm licenses list` (or `npm-license-checker`) on a checked-out
copy of the repository to obtain a complete, per-package, machine-
readable list.

---

## How attribution works in practice

* Every source file copied or substantially adapted from one of the
  upstreams above carries a header noting the original copyright and
  the date of modification, per the requirements of GPL-3.0 §5(a).
* This file (`THIRD-PARTY-NOTICES.md`) and `LICENSE`, `COPYRIGHT` are
  shipped alongside every SkipNet release (source archive AND
  installer) so end users can always trace provenance.
* If you find an upstream that should be acknowledged here and isn't,
  please open an issue at <https://github.com/slavniynazzik/SkipNet/issues> — we'll add it.
