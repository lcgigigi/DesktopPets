[CmdletBinding()]
param(
  [Parameter(Mandatory = $true)]
  [string]$MsiPath,

  [Parameter(Mandatory = $true)]
  [string]$ExpectedVersion
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

$ProductName = '华力AI桌面助手'
$MarkerPath = 'HKLM:\SOFTWARE\Huali\HualiAIDesktopAssistant'
$RunPath = 'HKLM:\SOFTWARE\Microsoft\Windows\CurrentVersion\Run'
$InstallLog = Join-Path $env:TEMP 'HualiAI-silent-install-smoke.log'
$UninstallLog = Join-Path $env:TEMP 'HualiAI-silent-uninstall-smoke.log'

function Test-IsAdministrator {
  $identity = [Security.Principal.WindowsIdentity]::GetCurrent()
  $principal = New-Object Security.Principal.WindowsPrincipal($identity)
  return $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
}

function Invoke-MsiExec {
  param([Parameter(Mandatory = $true)][string[]]$Arguments)

  $process = Start-Process -FilePath 'msiexec.exe' -ArgumentList $Arguments -Wait -PassThru
  if ($process.ExitCode -notin @(0, 3010, 1641)) {
    throw "Windows Installer 返回失败码：$($process.ExitCode)"
  }
  return $process.ExitCode
}

function Find-InstalledProduct {
  $roots = @(
    'HKLM:\SOFTWARE\Microsoft\Windows\CurrentVersion\Uninstall\*',
    'HKLM:\SOFTWARE\WOW6432Node\Microsoft\Windows\CurrentVersion\Uninstall\*'
  )
  return Get-ItemProperty -Path $roots -ErrorAction SilentlyContinue |
    Where-Object {
      $displayName = $_.PSObject.Properties['DisplayName']
      $windowsInstaller = $_.PSObject.Properties['WindowsInstaller']
      $displayName -and $windowsInstaller -and
        $displayName.Value -eq $ProductName -and $windowsInstaller.Value -eq 1
    } |
    Select-Object -First 1
}

if ($env:OS -ne 'Windows_NT') {
  throw '该脚本只能在 Windows 上运行。'
}
if (-not (Test-IsAdministrator)) {
  throw '静默部署冒烟测试必须由管理员运行。'
}

$resolvedMsi = (Resolve-Path -LiteralPath $MsiPath).Path
$installedProduct = $null
try {
  Write-Host '验证管理员 /qn 全静默安装（禁止测试机立即启动）...'
  Invoke-MsiExec -Arguments @(
    '/i', ('"{0}"' -f $resolvedMsi),
    '/qn', '/norestart', 'REBOOT=ReallySuppress', 'HUALI_START_AFTER_INSTALL=0',
    '/L*v', ('"{0}"' -f $InstallLog)
  ) | Out-Null

  $installedProduct = Find-InstalledProduct
  if (-not $installedProduct) {
    throw '安装完成后未找到 Windows Installer 产品登记。'
  }
  if ([string]$installedProduct.DisplayVersion -ne $ExpectedVersion) {
    throw "安装版本错误：实际=$($installedProduct.DisplayVersion)，预期=$ExpectedVersion"
  }
  $marker = Get-ItemProperty -LiteralPath $MarkerPath
  if ($marker.InstallerType -ne 'MSI' -or $marker.Version -ne $ExpectedVersion) {
    throw '整机安装检测标记不正确。'
  }
  $runValue = (Get-ItemProperty -LiteralPath $RunPath).'华力AI桌面助手'
  if ($runValue -notmatch '^"?(.+?HualiAIDesktopAssistant\.exe)"?$') {
    throw 'HKLM 登录自启动项不正确。'
  }
  $mainExecutable = $Matches[1]
  if (-not (Test-Path -LiteralPath $mainExecutable)) {
    throw "安装目录缺少主程序：$mainExecutable"
  }
  $separator = [IO.Path]::DirectorySeparatorChar
  $programFilesRoot = [IO.Path]::GetFullPath($env:ProgramFiles).TrimEnd($separator) + $separator
  $installedExecutablePath = [IO.Path]::GetFullPath($mainExecutable)
  if (-not $installedExecutablePath.StartsWith($programFilesRoot, [StringComparison]::OrdinalIgnoreCase)) {
    throw "程序未按计算机安装到 Program Files：$installedExecutablePath"
  }
  if (Get-Process -Name 'HualiAIDesktopAssistant' -ErrorAction SilentlyContinue) {
    throw 'HUALI_START_AFTER_INSTALL=0 时不应启动程序。'
  }

  Write-Host '管理员静默安装冒烟测试通过。'
} finally {
  if (-not $installedProduct) {
    $installedProduct = Find-InstalledProduct
  }
  if ($installedProduct) {
    $productCode = $installedProduct.PSChildName
    Write-Host '清理冒烟测试安装...'
    Invoke-MsiExec -Arguments @(
      '/x', $productCode,
      '/qn', '/norestart', 'REBOOT=ReallySuppress',
      '/L*v', ('"{0}"' -f $UninstallLog)
    ) | Out-Null
  }
}

if (Find-InstalledProduct) {
  throw '静默卸载后仍存在产品登记。'
}
if (Test-Path -LiteralPath $MarkerPath) {
  throw '静默卸载后仍存在整机安装检测标记。'
}

Write-Host '管理员 /qn 静默安装与卸载验证全部通过。'
