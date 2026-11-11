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

  ; Hide the "Version" column - electron-builder writes DisplayVersion from
  ; package.json. Removing both DisplayVersion and the numeric Major/Minor
  ; pair makes Programs & Features leave the column blank for SkipNet.
  DeleteRegValue SHCTX "${UNINSTALL_REGISTRY_KEY}" "DisplayVersion"
  DeleteRegValue SHCTX "${UNINSTALL_REGISTRY_KEY}" "VersionMajor"
  DeleteRegValue SHCTX "${UNINSTALL_REGISTRY_KEY}" "VersionMinor"
  DeleteRegValue SHCTX "${UNINSTALL_REGISTRY_KEY}" "Version"

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

  ; 6. Best-effort wipe for *other* users on the same machine, since
  ;    perMachine installs may have been used by anyone. We iterate over
  ;    C:\Users\* and remove any SkipNet userData under each profile.
  ;    Failures are silent - we can't always touch other users' folders
  ;    and that's fine; the per-user uninstaller will catch the rest.
  StrCpy $0 "$PROFILE\.."
  FindFirst $1 $2 "$0\*"
  user_loop:
    StrCmp $2 "" user_done
    StrCmp $2 "."         user_next
    StrCmp $2 ".."        user_next
    StrCmp $2 "Public"    user_next
    StrCmp $2 "Default"   user_next
    StrCmp $2 "Default User" user_next
    StrCmp $2 "All Users" user_next
    RMDir /r "$0\$2\AppData\Roaming\skipnet"
    RMDir /r "$0\$2\AppData\Local\skipnet"
    RMDir /r "$0\$2\AppData\Roaming\skipnet-dev"
    RMDir /r "$0\$2\AppData\Local\skipnet-dev"
    RMDir /r "$0\$2\AppData\Roaming\slipgate"
    RMDir /r "$0\$2\AppData\Local\slipgate"
    RMDir /r "$0\$2\AppData\Roaming\slipgate-dev"
    RMDir /r "$0\$2\AppData\Local\slipgate-dev"
  user_next:
    FindNext $1 $2
    Goto user_loop
  user_done:
  FindClose $1

  ; 7. Make sure the install directory itself is emptied - electron-builder
  ;    already deletes registered files, but some users / antivirus may
  ;    leave runtime-created stragglers (logs, generated configs, etc.).
  RMDir /r "$INSTDIR"

  skipnet_skip_wipe:
!macroend
