Unicode true
ManifestDPIAware true
SetCompressor /SOLID lzma

!include "LogicLib.nsh"

!define PRODUCT_NAME "华力AI桌面助手"
!define UNINSTALL_KEY "Software\Microsoft\Windows\CurrentVersion\Uninstall\${PRODUCT_NAME}"

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

Name "${PRODUCT_NAME}"
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

Var ExistingUninstallCommand
Var ExistingUninstallExitCode
Var InstallMutexHandle

Function .onInit
  ; Prevent two management-platform retries from uninstalling and installing
  ; the same machine package at the same time. 1618 is the standard Windows
  ; "another installation is already in progress" result.
  StrCpy $InstallMutexHandle ""
  System::Call 'kernel32::CreateMutexW(p 0, i 0, w "Global\HualiAIDesktopAssistantEnterpriseInstall") p .rInstallMutexHandle ?e'
  Pop $R0
  ${If} $R0 = 183
    SetErrorLevel 1618
    Quit
  ${EndIf}
  ${If} $InstallMutexHandle = 0
    ${If} $R0 = 0
      StrCpy $R0 1
    ${EndIf}
    SetErrorLevel $R0
    Quit
  ${EndIf}
FunctionEnd

Function .onGUIEnd
  ; The OS would close this handle when the wrapper exits, but release it
  ; explicitly so the deployment platform can retry immediately afterward.
  ${If} $InstallMutexHandle != ""
    System::Call 'kernel32::CloseHandle(p rInstallMutexHandle)'
  ${EndIf}
FunctionEnd

Function RemoveExistingMachineInstall
  ; The x64 Tauri package writes its uninstall registration to the 64-bit HKLM
  ; view. An older enterprise deployment may still have its uninstaller even
  ; if the registry registration was partially removed, so also check the
  ; deterministic Program Files location.
  SetRegView 64
  ClearErrors
  ReadRegStr $ExistingUninstallCommand HKLM "${UNINSTALL_KEY}" "UninstallString"

  ${If} $ExistingUninstallCommand == ""
    IfFileExists "$PROGRAMFILES64\${PRODUCT_NAME}\uninstall.exe" 0 no_existing_install
    StrCpy $ExistingUninstallCommand '$\"$PROGRAMFILES64\${PRODUCT_NAME}\uninstall.exe$\"'
  ${EndIf}

  DetailPrint "Removing the existing machine installation..."
  ClearErrors
  ExecWait '$ExistingUninstallCommand /S' $ExistingUninstallExitCode
  IfErrors existing_uninstall_failed
  ${If} $ExistingUninstallExitCode != 0
    Goto existing_uninstall_failed
  ${EndIf}

  ; Wait for the old uninstaller and its file cleanup to fully settle before
  ; the new installer recreates the same directory and shortcuts.
  Sleep 500
  ClearErrors
  Return

  no_existing_install:
    ClearErrors
    Return

  existing_uninstall_failed:
    SetErrors
FunctionEnd

Section
  InitPluginsDir
  SetOutPath "$PLUGINSDIR"
  File "/oname=HualiAIDesktopAssistant-setup.exe" "${SETUP_EXE}"

  Call RemoveExistingMachineInstall
  IfErrors wrapper_failed

  ClearErrors
  ; /R asks Tauri's installer helper to launch the app as the interactive
  ; desktop user after a successful silent install, even when this wrapper is
  ; elevated by the deployment platform.
  ExecWait '"$PLUGINSDIR\HualiAIDesktopAssistant-setup.exe" /S /R' $0
  IfErrors wrapper_failed

  SetErrorLevel $0
  Quit

  wrapper_failed:
    SetErrorLevel 1
SectionEnd
