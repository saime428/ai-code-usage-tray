; The app writes its own launch-at-login entry with reg.exe, so the uninstaller has to
; remove it too — NSIS only cleans up what it created, and a leftover value keeps showing
; up in Task Manager > Startup pointing at a deleted exe.
!macro customUnInstall
  DeleteRegValue HKCU "Software\Microsoft\Windows\CurrentVersion\Run" "AI Code Usage Tray"
  DeleteRegValue HKCU "Software\Microsoft\Windows\CurrentVersion\Run" "electron.app.AI Code Usage Tray"
!macroend
