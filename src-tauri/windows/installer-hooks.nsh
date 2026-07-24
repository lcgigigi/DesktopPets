; The GUI installer starts the new app as soon as installation succeeds. Keep
; the finish-page checkbox available as a manual fallback, but leave it
; unchecked so it cannot launch a duplicate instance.
!define MUI_FINISHPAGE_RUN_NOTCHECKED

!macro NSIS_HOOK_PREINSTALL
  ; Close the old binary before copying files. The enterprise installer must
  ; cover every logged-in session; the personal installer only owns the
  ; current user's process.
  !if "${INSTALLMODE}" == "currentUser"
    nsis_tauri_utils::KillProcessCurrentUser "${MAINBINARYNAME}.exe"
  !else
    nsis_tauri_utils::KillProcess "${MAINBINARYNAME}.exe"
  !endif
  Pop $R0
  ${If} $R0 != 0
  ${AndIf} $R0 != 2
    Abort "无法关闭正在运行的${PRODUCTNAME}，已停止安装。"
  ${EndIf}
  Sleep 500
!macroend

!macro NSIS_HOOK_POSTINSTALL
  ; The shortcut target changed from older releases. Notify Explorer so it
  ; discards the cached shortcut icon and reads the icon embedded in the new EXE.
  System::Call 'shell32::SHChangeNotify(i 0x08000000, i 0, p 0, p 0)'

  ; Silent enterprise installs launch through /R in .onInstSuccess. For the
  ; normal interactive installer, start immediately after the files and
  ; shortcuts are ready instead of requiring a second user click.
  IfSilent postinstall_launch_done
  ${If} $PassiveMode != 1
    nsis_tauri_utils::RunAsUser "$INSTDIR\${MAINBINARYNAME}.exe" ""
  ${EndIf}
  postinstall_launch_done:
!macroend

!macro NSIS_HOOK_POSTUNINSTALL
  System::Call 'shell32::SHChangeNotify(i 0x08000000, i 0, p 0, p 0)'
!macroend
