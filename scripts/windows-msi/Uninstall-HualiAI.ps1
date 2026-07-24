[CmdletBinding()]
param(
  [string]$LogPath
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

$ProductName = '华力AI桌面助手'

function Test-IsAdministrator {
  $identity = [Security.Principal.WindowsIdentity]::GetCurrent()
  $principal = New-Object Security.Principal.WindowsPrincipal($identity)
  return $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
}

function Find-InstalledProductCode {
  $baseKey = [Microsoft.Win32.RegistryKey]::OpenBaseKey(
    [Microsoft.Win32.RegistryHive]::LocalMachine,
    [Microsoft.Win32.RegistryView]::Registry64
  )
  try {
    $uninstallKey = $baseKey.OpenSubKey('SOFTWARE\Microsoft\Windows\CurrentVersion\Uninstall')
    if (-not $uninstallKey) {
      return $null
    }
    try {
      foreach ($subKeyName in $uninstallKey.GetSubKeyNames()) {
        $subKey = $uninstallKey.OpenSubKey($subKeyName)
        if (-not $subKey) {
          continue
        }
        try {
          if (($subKey.GetValue('DisplayName')) -eq $ProductName -and ($subKey.GetValue('WindowsInstaller')) -eq 1) {
            return $subKeyName
          }
        } finally {
          $subKey.Dispose()
        }
      }
    } finally {
      $uninstallKey.Dispose()
    }
  } finally {
    $baseKey.Dispose()
  }
  return $null
}

if ($env:OS -ne 'Windows_NT') {
  throw '该脚本只能在 Windows 上运行。'
}
if (-not (Test-IsAdministrator)) {
  throw '请由管理平台以管理员或 SYSTEM 身份运行该脚本。'
}

$productCode = Find-InstalledProductCode
if (-not $productCode) {
  Write-Host "$ProductName 未安装，无需卸载。"
  exit 0
}

if (-not $LogPath) {
  $logDirectory = Join-Path $env:ProgramData 'HualiAI\Logs'
  New-Item -ItemType Directory -Path $logDirectory -Force | Out-Null
  $LogPath = Join-Path $logDirectory "uninstall-$(Get-Date -Format 'yyyyMMdd-HHmmss').log"
}

$arguments = @(
  '/x', $productCode,
  '/qn',
  '/norestart',
  'REBOOT=ReallySuppress',
  '/L*v', ('"{0}"' -f $LogPath)
)

$process = Start-Process -FilePath 'msiexec.exe' -ArgumentList $arguments -Wait -PassThru
$exitCode = $process.ExitCode
if ($exitCode -notin @(0, 3010, 1605, 1641)) {
  [Console]::Error.WriteLine("卸载失败，Windows Installer 返回码：$exitCode。日志：$LogPath")
  exit $exitCode
}

Write-Host "卸载完成，Windows Installer 返回码：$exitCode。日志：$LogPath"
exit $exitCode
