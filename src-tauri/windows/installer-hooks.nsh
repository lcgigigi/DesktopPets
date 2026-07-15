!macro NSIS_HOOK_POSTINSTALL
  ; The shortcut target changed from older releases. Notify Explorer so it
  ; discards the cached shortcut icon and reads the icon embedded in the new EXE.
  System::Call 'shell32::SHChangeNotify(i 0x08000000, i 0, p 0, p 0)'
!macroend

!macro NSIS_HOOK_POSTUNINSTALL
  System::Call 'shell32::SHChangeNotify(i 0x08000000, i 0, p 0, p 0)'
!macroend
