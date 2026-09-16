; The app writes its own launch-at-login entry with reg.exe, so the uninstaller has to
; remove it too — NSIS only cleans up what it created, and a leftover value keeps showing
; up in Task Manager > Startup pointing at a deleted exe.
;
; Skip it when this uninstall is really an upgrade: a one-click install runs the old
; uninstaller first, and deleting the entry there would silently turn off launch-at-login
; on every update. Same guard electron-builder uses before removing app data.
!macro customUnInstall
  ${ifNot} ${isUpdated}
    DeleteRegValue HKCU "Software\Microsoft\Windows\CurrentVersion\Run" "AI Code Usage Tray"
    DeleteRegValue HKCU "Software\Microsoft\Windows\CurrentVersion\Run" "electron.app.AI Code Usage Tray"
  ${endIf}
!macroend
