; Sentinel NSIS installer hooks (tauri.conf.json
; bundle.windows.nsis.installerHooks).
;
; The daemon sidecar (sentinel-daemon.exe) is deliberately
; long-lived: it keeps proxying Claude Code traffic while the UI is closed,
; and Windows locks the executable of a running process. Without these
; hooks, installing or updating over a running daemon fails with
;   "Error opening file for writing: ...\sentinel-daemon.exe"
; (Tauri #7931 class). The in-app updater also stops the daemon before
; installing (daemon.rs stop_daemon_for_update); these hooks cover MANUAL
; runs of the -setup.exe and uninstalls, where the app never gets a say.
;
; The MSI carries the same kill via windows/daemon-close.wxs.

!macro NSIS_HOOK_PREINSTALL
  ; /F force-kill: the daemon is a windowless console process, so a graceful
  ; WM_CLOSE never lands. A failure (usually "process not found" on a clean
  ; install) is expected and ignored; Pop just clears nsExec's return value.
  nsExec::Exec 'taskkill /F /IM sentinel-daemon.exe'
  Pop $0
  ; Give Windows a beat to release the exe's file lock before file copy.
  Sleep 500
!macroend

!macro NSIS_HOOK_PREUNINSTALL
  nsExec::Exec 'taskkill /F /IM sentinel-daemon.exe'
  Pop $0
  Sleep 500
!macroend
