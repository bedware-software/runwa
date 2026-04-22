; Custom NSIS hooks for runwa's Windows installer.
;
; electron-builder auto-includes `build/installer.nsh` when present
; (the `buildResources` directory is configured in electron-builder.yml).
; We define four macros here — `preInit`, `customInit`, `customUnInit`,
; and `customUnInstall` — so every install / uninstall path force-stops
; any running runwa.exe (including orphan `ELECTRON_RUN_AS_NODE` helpers
; spawned by the in-app "Wipe all data" flow) before touching files.
;
; Without this, NSIS bails with "Failed to uninstall old application
; files" whenever anything is still holding a handle on the install
; directory — the exact symptom users see when upgrading from a live
; session (auto-update download → Quit from tray → running installer
; races the tray's slow teardown), or when the user manually double-
; clicks the new setup.exe without closing runwa first.
;
; `taskkill /IM runwa.exe` is safe here: the installer executable itself
; is named `runwa-<version>-setup.exe`, not `runwa.exe`, so this won't
; self-terminate.

!macro killRunwa
  DetailPrint "Stopping any running runwa instances..."
  ; /F — force, /T — include child processes. `>NUL 2>&1` swallows the
  ; "no process found" message when nothing was running.
  nsExec::Exec 'cmd /c taskkill /F /IM runwa.exe /T >NUL 2>&1'
  ; Windows needs a beat to release file handles after the process exits
  ; — without the sleep the immediate uninstall of the old version can
  ; still hit ERROR_SHARING_VIOLATION on just-released DLLs.
  Sleep 1500
!macroend

; Runs at the very top of the installer, before any checks. Kills old
; runwa processes so the subsequent "remove previous version" step
; finds a clean filesystem.
!macro customInit
  !insertmacro killRunwa
!macroend

; Safety net: the generated uninstaller (called both during update and
; when the user picks Uninstall from Control Panel) runs this before
; removing any files.
!macro customUnInit
  !insertmacro killRunwa
!macroend

!macro customUnInstall
  !insertmacro killRunwa
!macroend
