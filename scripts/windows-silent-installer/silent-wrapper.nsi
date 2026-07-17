Unicode true
ManifestDPIAware true
SetCompressor /SOLID lzma

!ifndef SETUP_EXE
  !error "SETUP_EXE is required"
!endif
!ifndef OUTPUT_EXE
  !error "OUTPUT_EXE is required"
!endif
!ifndef PRODUCT_VERSION
  !error "PRODUCT_VERSION is required"
!endif
!ifndef PRODUCT_VERSION_4
  !error "PRODUCT_VERSION_4 is required"
!endif
!ifndef INSTALLER_ICON
  !error "INSTALLER_ICON is required"
!endif

Name "华力AI桌面助手"
OutFile "${OUTPUT_EXE}"
Icon "${INSTALLER_ICON}"
RequestExecutionLevel admin
SilentInstall silent
AutoCloseWindow true
ShowInstDetails nevershow

VIProductVersion "${PRODUCT_VERSION_4}"
VIAddVersionKey "ProductName" "华力AI桌面助手"
VIAddVersionKey "FileDescription" "华力AI桌面助手企业静默安装包"
VIAddVersionKey "LegalCopyright" "huali"
VIAddVersionKey "FileVersion" "${PRODUCT_VERSION}"
VIAddVersionKey "ProductVersion" "${PRODUCT_VERSION}"

Section
  InitPluginsDir
  SetOutPath "$PLUGINSDIR"
  File "/oname=HualiAIDesktopAssistant-setup.exe" "${SETUP_EXE}"

  ClearErrors
  ExecWait '"$PLUGINSDIR\HualiAIDesktopAssistant-setup.exe" /S' $0
  IfErrors wrapper_failed

  SetErrorLevel $0
  Quit

  wrapper_failed:
    SetErrorLevel 1
SectionEnd
