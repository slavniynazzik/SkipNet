!macro customInstall
  ; --- Programs & Features registry overrides --------------------------------
  ; electron-builder writes a sensible default set of registry values into
  ; HKLM\Software\Microsoft\Windows\CurrentVersion\Uninstall\${UNINSTALL_REGISTRY_KEY}
  ; based on package.json. We override / clear a few of them explicitly so the
  ; entry shown in "Programs and Features" is exactly what we want, regardless
  ; of any leftover values from an upgrade-in-place over an older install.
  ;
  ; SHCTX resolves to HKLM for perMachine installs, HKCU otherwise - matching
  ; whichever hive electron-builder chose for the rest of the entry.

  ; Publisher column - the project author. Detail pane gets a separate line
  ; via the Comments value below.
  WriteRegStr SHCTX "${UNINSTALL_REGISTRY_KEY}" "Publisher" "slavniynazzik"
  WriteRegStr SHCTX "${UNINSTALL_REGISTRY_KEY}" "Comments" "slavniynazzik (SkipNet)"

  ; Ensure the icon shown next to SkipNet in P&F is *our* fresh icon,
  ; rebuilt from design/icon.svg into resources/icon.ico on every build.
  ; Pointing at the standalone .ico (instead of "SkipNet.exe,0") sidesteps
  ; Windows' aggressive icon cache: the path is different from any older
  ; install, so Explorer is forced to re-read the file from disk.
  WriteRegStr SHCTX "${UNINSTALL_REGISTRY_KEY}" "DisplayIcon" "$INSTDIR\resources\icon.ico"

  ; Strip any URL columns. package.json points at the project repository, but
  ; an upgrade over an older install may still carry previous values.
  DeleteRegValue SHCTX "${UNINSTALL_REGISTRY_KEY}" "URLInfoAbout"
  DeleteRegValue SHCTX "${UNINSTALL_REGISTRY_KEY}" "HelpLink"
  DeleteRegValue SHCTX "${UNINSTALL_REGISTRY_KEY}" "URLUpdateInfo"

  ; The "Version" column is deliberately LEFT ALONE: electron-builder writes
  ; DisplayVersion (and the numeric VersionMajor/VersionMinor pair) from
  ; package.json, and users must be able to tell installed builds apart in
  ; Programs & Features. Only the URL columns are removed.

  ; --- Pre-rebrand cleanup ---------------------------------------------------
  ; SkipNet may be installed over an older Slipgate build. Remove the old
  ; login tasks and protocol handler so autostart and `slipgate://` links can
  ; never launch a stale binary. The files of the old install are left to its
  ; own uninstaller; we only clear the shared system registrations.
  nsExec::ExecToLog 'schtasks /delete /tn "Slipgate Auto Start" /f'
  nsExec::ExecToLog 'schtasks /delete /tn "SlipgateAutoStart" /f'
  DeleteRegValue HKCU "Software\Microsoft\Windows\CurrentVersion\Run" "Slipgate"
  DeleteRegValue HKLM "Software\Microsoft\Windows\CurrentVersion\Run" "Slipgate"
  DeleteRegKey HKCR "slipgate"
  DeleteRegKey HKCU "Software\Classes\slipgate"

  ; --- Clear one-shot upgrade markers ---------------------------------------
  ; app-updater.ts writes these next to SkipNet.exe before launching the new
  ; installer so the OLD uninstaller can detect an in-place upgrade. They must
  ; not survive the upgrade: otherwise a later *manual* uninstall would still
  ; see them, skip the user-data wipe and leave every trace behind.
  Delete "$INSTDIR\.skipnet-upgrade"
  Delete "$INSTDIR\.slipgate-upgrade"
!macroend

!macro customUnInstall
  ; --- Full clean-uninstall ---------------------------------------------------
  ; By default electron-builder removes only the install directory. We ALSO
  ; want to delete every trace SkipNet ever left behind on the machine, so
  ; reinstalling later (or just uninstalling for good) leaves a pristine
  ; system: no userData, no logs, no scheduled task, no protocol handler.
  ;
  ; UPGRADE GUARD: when the in-app auto-updater (src/main/core/app-updater.ts)
  ; launches a newer installer, it first writes `$INSTDIR\.skipnet-upgrade`
  ; (and the legacy `.slipgate-upgrade` marker for the first rebranded
  ; update). The OLD installer's uninstaller (this macro) then runs as part
  ; of the in-place upgrade. If we performed the full wipe below, every user
  ; config, tgws secret and zapret strategy choice would be deleted on every
  ; update - the user explicitly does NOT want that. So when the marker is
  ; present we skip the destructive cleanup entirely (electron-builder still
  ; removes the install directory's tracked files) and let the new installer
  ; write fresh binaries over the old ones.
  ${if} ${isUpdated}
    Goto skipnet_skip_wipe
  ${endif}
  IfFileExists "$INSTDIR\.skipnet-upgrade" skipnet_skip_wipe 0
  IfFileExists "$INSTDIR\.slipgate-upgrade" skipnet_skip_wipe 0

  ; 1. Stop any running SkipNet / Slipgate / Zapret / proxy processes that
  ;    could keep files locked. /F = force, /T = include child processes.
  nsExec::ExecToLog 'taskkill /F /IM SkipNet.exe /T'
  nsExec::ExecToLog 'taskkill /F /IM Slipgate.exe /T'
  nsExec::ExecToLog 'taskkill /F /IM TgWsProxy_windows.exe /T'
  nsExec::ExecToLog 'taskkill /F /IM winws.exe /T'
  nsExec::ExecToLog 'taskkill /F /IM elevate.exe /T'
  Sleep 500

  ; 2. Remove any auto-start Scheduled Tasks, current and pre-rebrand names.
  nsExec::ExecToLog 'schtasks /delete /tn "SkipNetAutoStart" /f'
  nsExec::ExecToLog 'schtasks /delete /tn "Slipgate Auto Start" /f'
  nsExec::ExecToLog 'schtasks /delete /tn "SlipgateAutoStart" /f'

  ; 3. Remove run-on-login Registry keys (alternative auto-start mechanism).
  DeleteRegValue HKCU "Software\Microsoft\Windows\CurrentVersion\Run" "SkipNet"
  DeleteRegValue HKLM "Software\Microsoft\Windows\CurrentVersion\Run" "SkipNet"
  DeleteRegValue HKCU "Software\Microsoft\Windows\CurrentVersion\Run" "Slipgate"
  DeleteRegValue HKLM "Software\Microsoft\Windows\CurrentVersion\Run" "Slipgate"

  ; 4. Remove the URI-scheme protocol handlers SkipNet registers at runtime
  ;    (skipnet://, tg-ws:// - see src/main/utils/init.ts) plus the old
  ;    slipgate:// handler from pre-rebrand versions.
  DeleteRegKey HKCR "skipnet"
  DeleteRegKey HKCR "slipgate"
  DeleteRegKey HKCR "tg-ws"
  DeleteRegKey HKCU "Software\Classes\skipnet"
  DeleteRegKey HKCU "Software\Classes\slipgate"
  DeleteRegKey HKCU "Software\Classes\tg-ws"

  ; 5. Wipe the user-data folders for the *current* user (the one running
  ;    the uninstaller). `current` ensures $APPDATA / $LOCALAPPDATA resolve
  ;    to that user's profile even though we installed perMachine.
  ; SkipNet's userData lives in `skipnet` (production) and `skipnet-dev`
  ; (developer sandbox, see src/main/index.ts -> app.setName). We also wipe
  ; the pre-rebrand `slipgate` / `slipgate-dev` folders so an upgraded
  ; machine is left completely clean.
  ;
  ; MULTI-USER SAFETY (CA2 / audit P1-2): a previous version of this
  ; uninstaller walked `C:\Users\*` and deleted every profile's
  ; %APPDATA%/%LOCALAPPDATA%\skipnet. On a shared machine that destroyed
  ; other users' settings and TgWs secrets without their consent, and the
  ; loop also followed directory junctions. We now ONLY touch the profile
  ; that is actually running the uninstaller. Other users keep their data
  ; until they uninstall / reset it themselves. A machine-wide install no
  ; longer implies a machine-wide data wipe.
  SetShellVarContext current
  RMDir /r "$APPDATA\skipnet"
  RMDir /r "$LOCALAPPDATA\skipnet"
  RMDir /r "$APPDATA\skipnet-dev"
  RMDir /r "$LOCALAPPDATA\skipnet-dev"
  RMDir /r "$APPDATA\slipgate"
  RMDir /r "$LOCALAPPDATA\slipgate"
  RMDir /r "$APPDATA\slipgate-dev"
  RMDir /r "$LOCALAPPDATA\slipgate-dev"
  SetShellVarContext all

  ; 6. WinDivert kernel-driver service. winws.exe creates/uses a service for
  ;    the bundled WinDivert64.sys. The .sys lives under $INSTDIR and is being
  ;    removed, so leaving the service registration behind would produce a
  ;    broken service (error 577/1058) that blocks the next install from
  ;    loading the driver. Stop first (ignore errors when it is not running),
  ;    then delete the registration. This runs only on a real uninstall: the
  ;    upgrade guard above already skipped the whole block for in-place
  ;    updates.
  ;
  ;    Trade-off: `sc delete` is unconditional because parsing localised
  ;    `sc qc` output in NSIS is brittle. If another DPI-bypass install shares
  ;    these exact WinDivert service names, its registration is removed too;
  ;    the shared driver files are not touched. `sc` service lookup is
  ;    case-insensitive, so WinDivert / windivert need one entry only.
  nsExec::ExecToLog 'sc stop WinDivert'
  nsExec::ExecToLog 'sc stop WinDivert14'
  nsExec::ExecToLog 'sc stop WinDivert64'
  nsExec::ExecToLog 'sc delete WinDivert'
  nsExec::ExecToLog 'sc delete WinDivert14'
  nsExec::ExecToLog 'sc delete WinDivert64'

  ; NOTE: the install directory is removed by electron-builder's own
  ; uninstaller *after* this macro returns. Do not `RMDir /r "$INSTDIR"`
  ; here as well: removing it twice raced with the upstream cleanup and
  ; could leave the uninstaller reporting a failed removal.

  skipnet_skip_wipe:
!macroend
