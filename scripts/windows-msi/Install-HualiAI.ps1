[CmdletBinding()]
param(
  [Parameter(Mandatory = $true)]
  [string]$MsiPath,

  [string]$LogPath,

  [switch]$DoNotLaunchNow
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

$ProductName = '华力AI桌面助手'

function Test-IsAdministrator {
  $identity = [Security.Principal.WindowsIdentity]::GetCurrent()
  $principal = New-Object Security.Principal.WindowsPrincipal($identity)
  return $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
}

if ($env:OS -ne 'Windows_NT') {
  throw '该脚本只能在 Windows 上运行。'
}
if (-not (Test-IsAdministrator)) {
  throw '请由管理平台以管理员或 SYSTEM 身份运行该脚本。'
}

$resolvedMsi = (Resolve-Path -LiteralPath $MsiPath).Path
if ([IO.Path]::GetExtension($resolvedMsi) -ne '.msi') {
  throw "不是 MSI 文件：$resolvedMsi"
}

if (-not $LogPath) {
  $logDirectory = Join-Path $env:ProgramData 'HualiAI\Logs'
  New-Item -ItemType Directory -Path $logDirectory -Force | Out-Null
  $LogPath = Join-Path $logDirectory "install-$(Get-Date -Format 'yyyyMMdd-HHmmss').log"
} else {
  $logDirectory = Split-Path -Parent $LogPath
  if ($logDirectory) {
    New-Item -ItemType Directory -Path $logDirectory -Force | Out-Null
  }
}

$arguments = @(
  '/i', ('"{0}"' -f $resolvedMsi),
  '/qn',
  '/norestart',
  'REBOOT=ReallySuppress',
  '/L*v', ('"{0}"' -f $LogPath)
)
if ($DoNotLaunchNow) {
  $arguments += 'HUALI_START_AFTER_INSTALL=0'
}

Write-Host "正在静默安装 $ProductName..."
$process = Start-Process -FilePath 'msiexec.exe' -ArgumentList $arguments -Wait -PassThru
$exitCode = $process.ExitCode

if ($exitCode -notin @(0, 3010, 1641)) {
  [Console]::Error.WriteLine("安装失败，Windows Installer 返回码：$exitCode。日志：$LogPath")
  exit $exitCode
}

Write-Host "安装成功，Windows Installer 返回码：$exitCode。日志：$LogPath"
if ($DoNotLaunchNow) {
  Write-Host '已按参数禁用安装后立即启动。'
} else {
  Write-Host '安装包已请求在当前已登录的用户桌面立即启动应用。'
}

exit $exitCode
