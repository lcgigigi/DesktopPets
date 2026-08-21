[CmdletBinding()]
param(
  [Parameter(Mandatory = $true)]
  [string]$MsiPath,

  [Parameter(Mandatory = $true)]
  [string]$ExpectedVersion,

  [string]$PreviousMsiPath = '',

  [string]$PreviousVersion = '1.0.38',

  [string]$PreviousMsiSha256 = '49f38a75d098946deea7c570df7911a46bc3f361a935c58279a073cc1d00655a',

  [switch]$RunVisualSmoke,

  [string]$VisualSmokeOutputDirectory = '',

  [switch]$ValidateDefaultLaunch,

  [switch]$RequireInteractiveDefaultLaunch,

  [string]$EvidenceDirectory = ''
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

$ProductName = '华力AI桌面助手'
$ProcessName = 'HualiAIDesktopAssistant'
$MarkerPath = 'HKLM:\SOFTWARE\Huali\HualiAIDesktopAssistant'
$RunPath = 'HKLM:\SOFTWARE\Microsoft\Windows\CurrentVersion\Run'
$RunValueName = '华力AI桌面助手'
$LaunchLogPath = Join-Path $env:ProgramData 'HualiAI\Logs\launch-after-install.log'

function Test-IsAdministrator {
  $identity = [Security.Principal.WindowsIdentity]::GetCurrent()
  $principal = New-Object Security.Principal.WindowsPrincipal($identity)
  return $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
}

function Invoke-MsiExec {
  param(
    [Parameter(Mandatory = $true)][string[]]$Arguments,
    [int[]]$AllowedExitCodes = @(0, 3010),
    [int]$TimeoutSeconds = 900
  )

  $process = Start-Process -FilePath 'msiexec.exe' -ArgumentList $Arguments -PassThru
  if (-not $process.WaitForExit($TimeoutSeconds * 1000)) {
    Stop-Process -Id $process.Id -Force -ErrorAction SilentlyContinue
    throw "Windows Installer 在 $TimeoutSeconds 秒内未结束，疑似静默部署挂起。"
  }
  $process.Refresh()
  if ($process.ExitCode -notin $AllowedExitCodes) {
    throw "Windows Installer 返回失败码：$($process.ExitCode)"
  }
  return $process.ExitCode
}

function Get-InstalledProducts {
  $roots = @(
    'HKLM:\SOFTWARE\Microsoft\Windows\CurrentVersion\Uninstall\*',
    'HKLM:\SOFTWARE\WOW6432Node\Microsoft\Windows\CurrentVersion\Uninstall\*'
  )
  return @(Get-ItemProperty -Path $roots -ErrorAction SilentlyContinue |
    Where-Object {
      $displayName = $_.PSObject.Properties['DisplayName']
      $windowsInstaller = $_.PSObject.Properties['WindowsInstaller']
      $displayName -and $windowsInstaller -and
        $displayName.Value -eq $ProductName -and $windowsInstaller.Value -eq 1
    } |
    Sort-Object PSPath -Unique)
}

function Get-RunExecutablePath {
  $runKey = Get-ItemProperty -LiteralPath $RunPath -ErrorAction SilentlyContinue
  $runProperty = if ($runKey) { $runKey.PSObject.Properties[$RunValueName] } else { $null }
  if (-not $runProperty) {
    throw 'HKLM 登录自启动项不存在。'
  }
  $runValue = [string]$runProperty.Value
  if ($runValue -notmatch '^"?(.+?HualiAIDesktopAssistant\.exe)"?$') {
    throw "HKLM 登录自启动项格式不正确：$runValue"
  }
  return $Matches[1]
}

function Get-HualiProcesses {
  return @(Get-Process -Name $ProcessName -ErrorAction SilentlyContinue)
}

function Stop-HualiProcesses {
  Get-HualiProcesses | Stop-Process -Force -ErrorAction SilentlyContinue
  $deadline = [DateTime]::UtcNow.AddSeconds(10)
  while (@(Get-HualiProcesses).Count -gt 0 -and [DateTime]::UtcNow -lt $deadline) {
    Start-Sleep -Milliseconds 100
  }
  if (@(Get-HualiProcesses).Count -gt 0) {
    throw '无法停止华力 AI 桌面助手进程。'
  }
}

function Assert-NoHualiProcesses {
  param([Parameter(Mandatory = $true)][string]$Stage)

  $processes = @(Get-HualiProcesses)
  if ($processes.Count -gt 0) {
    throw "$Stage 后仍有 $($processes.Count) 个华力 AI 桌面助手进程。"
  }
}

function Assert-InstalledState {
  param([Parameter(Mandatory = $true)][string]$Version)

  $products = @(Get-InstalledProducts)
  if ($products.Count -ne 1) {
    throw "安装登记数量错误：实际=$($products.Count)，预期=1。"
  }
  $product = $products[0]
  if ([string]$product.DisplayVersion -ne $Version) {
    throw "安装版本错误：实际=$($product.DisplayVersion)，预期=$Version。"
  }

  $marker = Get-ItemProperty -LiteralPath $MarkerPath -ErrorAction Stop
  if ($marker.InstallerType -ne 'MSI' -or [string]$marker.Version -ne $Version) {
    throw "整机安装检测标记错误：InstallerType=$($marker.InstallerType)，Version=$($marker.Version)。"
  }

  $mainExecutable = Get-RunExecutablePath
  if (-not (Test-Path -LiteralPath $mainExecutable -PathType Leaf)) {
    throw "安装目录缺少主程序：$mainExecutable"
  }
  $separator = [IO.Path]::DirectorySeparatorChar
  $programFilesRoot = [IO.Path]::GetFullPath($env:ProgramFiles).TrimEnd($separator) + $separator
  $installedExecutablePath = [IO.Path]::GetFullPath($mainExecutable)
  if (-not $installedExecutablePath.StartsWith($programFilesRoot, [StringComparison]::OrdinalIgnoreCase)) {
    throw "程序未按计算机安装到 Program Files：$installedExecutablePath"
  }

  return [pscustomobject]@{
    ProductCode = [string]$product.PSChildName
    Version = [string]$product.DisplayVersion
    ExecutablePath = $installedExecutablePath
    ExecutableSha256 = (Get-FileHash -LiteralPath $installedExecutablePath -Algorithm SHA256).Hash.ToLowerInvariant()
  }
}

function Assert-UninstalledState {
  param(
    [Parameter(Mandatory = $true)][string]$Stage,
    [string]$FormerExecutablePath = ''
  )

  $products = @(Get-InstalledProducts)
  if ($products.Count -ne 0) {
    throw "$Stage 后仍存在 $($products.Count) 条 Windows Installer 产品登记。"
  }
  if (Test-Path -LiteralPath $MarkerPath) {
    throw "$Stage 后仍存在整机安装检测标记。"
  }
  $runKey = Get-ItemProperty -LiteralPath $RunPath -ErrorAction SilentlyContinue
  if ($runKey -and $runKey.PSObject.Properties[$RunValueName]) {
    throw "$Stage 后仍存在 HKLM 登录自启动项。"
  }
  if ($FormerExecutablePath -and (Test-Path -LiteralPath $FormerExecutablePath -PathType Leaf)) {
    throw "$Stage 后主程序仍残留：$FormerExecutablePath"
  }
  if ($FormerExecutablePath) {
    $formerInstallDirectory = Split-Path -Parent $FormerExecutablePath
    if (Test-Path -LiteralPath $formerInstallDirectory) {
      throw "$Stage 后安装目录仍残留：$formerInstallDirectory"
    }
  }
  Assert-NoHualiProcesses -Stage $Stage
}

function Invoke-Install {
  param(
    [Parameter(Mandatory = $true)][string]$ResolvedMsi,
    [Parameter(Mandatory = $true)][string]$LogPath,
    [switch]$DisableLaunch
  )

  $arguments = @(
    '/i', ('"{0}"' -f $ResolvedMsi),
    '/qn', '/norestart', 'REBOOT=ReallySuppress',
    '/L*v', ('"{0}"' -f $LogPath)
  )
  if ($DisableLaunch) {
    $arguments += 'HUALI_START_AFTER_INSTALL=0'
  }
  Invoke-MsiExec -Arguments $arguments | Out-Null
}

function Invoke-UninstallProduct {
  param(
    [Parameter(Mandatory = $true)][string]$ProductCode,
    [Parameter(Mandatory = $true)][string]$LogPath
  )

  Invoke-MsiExec -Arguments @(
    '/x', $ProductCode,
    '/qn', '/norestart', 'REBOOT=ReallySuppress',
    '/L*v', ('"{0}"' -f $LogPath)
  ) | Out-Null
}

function Get-InteractiveExplorerSessions {
  return @(Get-Process -Name 'explorer' -ErrorAction SilentlyContinue |
      Where-Object { $_.SessionId -gt 0 } |
      Select-Object -ExpandProperty SessionId -Unique)
}

function Wait-ForDefaultLaunch {
  param(
    [Parameter(Mandatory = $true)][string]$ExecutablePath,
    [Parameter(Mandatory = $true)][int[]]$InteractiveSessions,
    [int]$TimeoutSeconds = 30
  )

  $deadline = [DateTime]::UtcNow.AddSeconds($TimeoutSeconds)
  do {
    foreach ($process in Get-HualiProcesses) {
      $path = ''
      try {
        $path = [string]$process.Path
      } catch {
        $path = ''
      }
      if ($path -and
          [IO.Path]::GetFullPath($path).Equals(
            [IO.Path]::GetFullPath($ExecutablePath),
            [StringComparison]::OrdinalIgnoreCase
          ) -and
          $process.SessionId -in $InteractiveSessions -and
          [HualiDeploymentSmokeNative]::HasVisibleApplicationWindow($process.Id)) {
        return $process
      }
    }
    Start-Sleep -Milliseconds 250
  } while ([DateTime]::UtcNow -lt $deadline)

  throw '默认安装完成后，未在已登录交互用户会话找到主程序及可见窗口。'
}

function Get-LaunchLogLineCount {
  if (-not (Test-Path -LiteralPath $LaunchLogPath -PathType Leaf)) {
    return 0
  }
  return @(Get-Content -LiteralPath $LaunchLogPath -ErrorAction Stop).Count
}

function Wait-ForNewLaunchLogLine {
  param(
    [Parameter(Mandatory = $true)][int]$StartingLineCount,
    [Parameter(Mandatory = $true)][string]$Pattern,
    [int]$TimeoutSeconds = 20
  )

  $deadline = [DateTime]::UtcNow.AddSeconds($TimeoutSeconds)
  do {
    if (Test-Path -LiteralPath $LaunchLogPath -PathType Leaf) {
      $allLines = @(Get-Content -LiteralPath $LaunchLogPath -ErrorAction Stop)
      if ($allLines.Count -gt $StartingLineCount) {
        $newLines = @($allLines | Select-Object -Skip $StartingLineCount)
        $match = $newLines | Where-Object { $_ -match $Pattern } | Select-Object -Last 1
        if ($match) {
          return [string]$match
        }
      }
    }
    Start-Sleep -Milliseconds 250
  } while ([DateTime]::UtcNow -lt $deadline)

  throw "安装后启动辅助程序未在新日志中写入预期状态：$Pattern"
}

function Wait-ForVisibleApplicationWindow {
  param(
    [Parameter(Mandatory = $true)][Diagnostics.Process]$Process,
    [int]$TimeoutSeconds = 30
  )

  $deadline = [DateTime]::UtcNow.AddSeconds($TimeoutSeconds)
  do {
    $Process.Refresh()
    if ($Process.HasExited) {
      throw "覆盖升级前启动的旧版程序提前退出，退出码=$($Process.ExitCode)。"
    }
    $windowHandle = [HualiDeploymentSmokeNative]::FindVisibleApplicationWindow($Process.Id)
    if ($windowHandle -ne [IntPtr]::Zero) {
      return $windowHandle.ToInt64()
    }
    Start-Sleep -Milliseconds 250
  } while ([DateTime]::UtcNow -lt $deadline)

  throw "旧版程序已启动，但 $TimeoutSeconds 秒内没有出现可见主窗口。"
}

if ($env:OS -ne 'Windows_NT') {
  throw '该脚本只能在 Windows 上运行。'
}
if (-not (Test-IsAdministrator)) {
  throw '静默部署冒烟测试必须由管理员运行。'
}
if ($RequireInteractiveDefaultLaunch -and -not $ValidateDefaultLaunch) {
  throw '-RequireInteractiveDefaultLaunch 必须与 -ValidateDefaultLaunch 同时使用。'
}

Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;

public static class HualiDeploymentSmokeNative
{
    private static readonly IntPtr PerMonitorAwareV2 = new IntPtr(-4);

    [StructLayout(LayoutKind.Sequential)]
    private struct RECT
    {
        public int Left;
        public int Top;
        public int Right;
        public int Bottom;
    }

    private delegate bool EnumWindowsProc(IntPtr hWnd, IntPtr lParam);

    [DllImport("user32.dll")]
    private static extern bool EnumWindows(EnumWindowsProc callback, IntPtr lParam);

    [DllImport("user32.dll")]
    private static extern bool IsWindowVisible(IntPtr hWnd);

    [DllImport("user32.dll")]
    private static extern uint GetWindowThreadProcessId(IntPtr hWnd, out uint processId);

    [DllImport("user32.dll")]
    private static extern bool GetWindowRect(IntPtr hWnd, out RECT rect);

    [DllImport("user32.dll", SetLastError = true)]
    private static extern bool SetProcessDpiAwarenessContext(IntPtr value);

    [DllImport("user32.dll", SetLastError = true)]
    private static extern IntPtr SetThreadDpiAwarenessContext(IntPtr value);

    [DllImport("user32.dll")]
    private static extern IntPtr GetThreadDpiAwarenessContext();

    [DllImport("user32.dll")]
    private static extern bool AreDpiAwarenessContextsEqual(IntPtr first, IntPtr second);

    public static bool EnablePerMonitorV2()
    {
        SetProcessDpiAwarenessContext(PerMonitorAwareV2);
        if (SetThreadDpiAwarenessContext(PerMonitorAwareV2) == IntPtr.Zero)
        {
            return false;
        }
        return AreDpiAwarenessContextsEqual(
            GetThreadDpiAwarenessContext(),
            PerMonitorAwareV2
        );
    }

    public static IntPtr FindVisibleApplicationWindow(int processId)
    {
        IntPtr found = IntPtr.Zero;
        EnumWindows((hWnd, _) =>
        {
            uint owner;
            RECT rect;
            GetWindowThreadProcessId(hWnd, out owner);
            if (owner == processId && IsWindowVisible(hWnd) && GetWindowRect(hWnd, out rect) &&
                rect.Right - rect.Left >= 100 && rect.Bottom - rect.Top >= 80)
            {
                found = hWnd;
                return false;
            }
            return true;
        }, IntPtr.Zero);
        return found;
    }

    public static bool HasVisibleApplicationWindow(int processId)
    {
        return FindVisibleApplicationWindow(processId) != IntPtr.Zero;
    }
}
'@

if (-not [HualiDeploymentSmokeNative]::EnablePerMonitorV2()) {
  throw '无法将 Windows 部署验收线程设置为 Per-Monitor-V2 DPI 模式。'
}

if (-not $EvidenceDirectory.Trim()) {
  $EvidenceDirectory = Join-Path $env:TEMP 'HualiAI-deployment-smoke'
}
$resolvedEvidence = [IO.Path]::GetFullPath($EvidenceDirectory)
New-Item -ItemType Directory -Path $resolvedEvidence -Force | Out-Null
if (-not $VisualSmokeOutputDirectory.Trim()) {
  $VisualSmokeOutputDirectory = Join-Path $resolvedEvidence 'windows-visual-smoke'
}
$resolvedVisualEvidence = [IO.Path]::GetFullPath($VisualSmokeOutputDirectory)

$resolvedMsi = ''
$resolvedPreviousMsi = ''

$report = [ordered]@{
  expectedVersion = $ExpectedVersion
  currentMsiSha256 = $null
  previousVersion = if ($PreviousMsiPath.Trim()) { $PreviousVersion } else { $null }
  previousMsiExpectedSha256 = if ($PreviousMsiPath.Trim()) { $PreviousMsiSha256.ToLowerInvariant() } else { $null }
  previousMsiActualSha256 = $null
  dpiAwareness = 'PerMonitorAwareV2'
  startedAt = [DateTime]::UtcNow.ToString('o')
  ok = $false
  failure = $null
  cleanup = $null
  checks = [ordered]@{}
}
$primaryFailure = $null
$cleanupFailure = $null
$cleanupAuthorized = $false
$lastExecutablePath = ''

try {
  if ($ExpectedVersion -notmatch '^\d+\.\d+\.\d+$') {
    throw "预期版本号必须是三段数字：$ExpectedVersion"
  }
  $resolvedMsi = (Resolve-Path -LiteralPath $MsiPath).Path
  if ([IO.Path]::GetExtension($resolvedMsi) -ne '.msi') {
    throw "当前安装包不是 MSI：$resolvedMsi"
  }
  $report.currentMsiSha256 = (Get-FileHash -LiteralPath $resolvedMsi -Algorithm SHA256).Hash.ToLowerInvariant()
  if ($PreviousMsiPath.Trim()) {
    if ($PreviousMsiSha256 -notmatch '^[0-9a-fA-F]{64}$') {
      throw "上一版 MSI SHA256 格式不正确：$PreviousMsiSha256"
    }
    $resolvedPreviousMsi = (Resolve-Path -LiteralPath $PreviousMsiPath).Path
    if ([IO.Path]::GetExtension($resolvedPreviousMsi) -ne '.msi') {
      throw "上一版安装包不是 MSI：$resolvedPreviousMsi"
    }
    $actualPreviousHash = (Get-FileHash -LiteralPath $resolvedPreviousMsi -Algorithm SHA256).Hash.ToLowerInvariant()
    $report.previousMsiActualSha256 = $actualPreviousHash
    if ($actualPreviousHash -ne $PreviousMsiSha256.Trim().ToLowerInvariant()) {
      throw "上一版 MSI SHA256 错误：实际=$actualPreviousHash，预期=$PreviousMsiSha256。"
    }
  }

  Assert-UninstalledState -Stage '测试开始前'
  $cleanupAuthorized = $true

  if ($resolvedPreviousMsi) {
    Write-Host "验证 $PreviousVersion 管理员 /qn 基线安装..."
    Invoke-Install `
      -ResolvedMsi $resolvedPreviousMsi `
      -LogPath (Join-Path $resolvedEvidence '01-previous-install.log') `
      -DisableLaunch
    $previousState = Assert-InstalledState -Version $PreviousVersion
    $lastExecutablePath = $previousState.ExecutablePath
    Assert-NoHualiProcesses -Stage "$PreviousVersion 禁止启动安装"
    $report.checks.previousInstall = $previousState

    $previousProcess = Start-Process `
      -FilePath $previousState.ExecutablePath `
      -WorkingDirectory (Split-Path -Parent $previousState.ExecutablePath) `
      -PassThru
    $previousWindowHandle = Wait-ForVisibleApplicationWindow -Process $previousProcess
    $previousProcessId = $previousProcess.Id
    $report.checks.runningPreviousVersion = [ordered]@{
      processId = $previousProcessId
      sessionId = $previousProcess.SessionId
      windowHandle = $previousWindowHandle
      executablePath = $previousState.ExecutablePath
      visibleWindowVerified = $true
    }

    Write-Host "验证运行中 $PreviousVersion -> $ExpectedVersion 管理员 /qn 覆盖升级..."
    Invoke-Install `
      -ResolvedMsi $resolvedMsi `
      -LogPath (Join-Path $resolvedEvidence '02-upgrade-current.log') `
      -DisableLaunch
    $currentState = Assert-InstalledState -Version $ExpectedVersion
    $lastExecutablePath = $currentState.ExecutablePath
    if ($currentState.ProductCode -eq $previousState.ProductCode) {
      throw '覆盖升级后 ProductCode 未变化。'
    }
    if (-not $currentState.ExecutablePath.Equals(
        $previousState.ExecutablePath,
        [StringComparison]::OrdinalIgnoreCase
      )) {
      throw "覆盖升级改变了正式安装路径：旧=$($previousState.ExecutablePath)，新=$($currentState.ExecutablePath)。"
    }
    if ($currentState.ExecutableSha256 -eq $previousState.ExecutableSha256) {
      throw '覆盖升级后主程序 SHA256 未变化，疑似仍在运行上一版文件。'
    }
    if (@(Get-InstalledProducts | Where-Object { $_.PSChildName -eq $previousState.ProductCode }).Count -ne 0) {
      throw '覆盖升级后旧 ProductCode 仍存在。'
    }
    $previousProcess.Refresh()
    if (-not $previousProcess.HasExited) {
      throw "覆盖升级后旧版进程 $previousProcessId 仍在运行，MSI CloseApplication 未生效。"
    }
    Assert-NoHualiProcesses -Stage "$ExpectedVersion 禁止启动覆盖升级"
    $report.checks.upgrade = [ordered]@{
      previousProductCode = $previousState.ProductCode
      currentProductCode = $currentState.ProductCode
      executablePathStable = $true
      previousExecutableSha256 = $previousState.ExecutableSha256
      currentExecutableSha256 = $currentState.ExecutableSha256
      singleProductRegistration = $true
      runningPreviousProcessClosed = $true
      currentProcessNotAutoStarted = $true
    }
  } else {
    Write-Host "验证 $ExpectedVersion 管理员 /qn 空机安装..."
    Invoke-Install `
      -ResolvedMsi $resolvedMsi `
      -LogPath (Join-Path $resolvedEvidence '01-current-install.log') `
      -DisableLaunch
    $currentState = Assert-InstalledState -Version $ExpectedVersion
    $lastExecutablePath = $currentState.ExecutablePath
    Assert-NoHualiProcesses -Stage "$ExpectedVersion 禁止启动安装"
    $report.checks.cleanInstall = $currentState
  }

  $installedBeforeFirstUninstall = Assert-InstalledState -Version $ExpectedVersion
  Invoke-UninstallProduct `
    -ProductCode $installedBeforeFirstUninstall.ProductCode `
    -LogPath (Join-Path $resolvedEvidence '03-upgraded-uninstall.log')
  Assert-UninstalledState `
    -Stage '覆盖升级包静默卸载' `
    -FormerExecutablePath $installedBeforeFirstUninstall.ExecutablePath
  $report.checks.upgradedUninstall = [ordered]@{
    productRegistrationRemoved = $true
    markerRemoved = $true
    runValueRemoved = $true
    executableRemoved = $true
    installDirectoryRemoved = $true
    processRemoved = $true
  }

  if ($ValidateDefaultLaunch) {
    $currentSessionId = [Diagnostics.Process]::GetCurrentProcess().SessionId
    $interactiveSessions = @(Get-InteractiveExplorerSessions)
    if ($interactiveSessions.Count -gt 0 -and $currentSessionId -notin $interactiveSessions) {
      throw "当前验收进程在会话 $currentSessionId，Explorer 位于其他会话；无法可靠截图和识别默认启动窗口。"
    }

    Write-Host '验证正式默认的安装后立即启动路径...'
    $launchLogLineCount = Get-LaunchLogLineCount
    Invoke-Install `
      -ResolvedMsi $resolvedMsi `
      -LogPath (Join-Path $resolvedEvidence '04-current-default-launch-install.log')
    $defaultLaunchState = Assert-InstalledState -Version $ExpectedVersion
    $lastExecutablePath = $defaultLaunchState.ExecutablePath
    if ($currentSessionId -in $interactiveSessions) {
      $launchedProcess = Wait-ForDefaultLaunch `
        -ExecutablePath $defaultLaunchState.ExecutablePath `
        -InteractiveSessions $interactiveSessions
      $launchLogLine = Wait-ForNewLaunchLogLine `
        -StartingLineCount $launchLogLineCount `
        -Pattern 'STARTED account='
      $report.checks.defaultLaunch = [ordered]@{
        status = 'interactive-launch-verified'
        processId = $launchedProcess.Id
        sessionId = $launchedProcess.SessionId
        windowHandle = [HualiDeploymentSmokeNative]::FindVisibleApplicationWindow($launchedProcess.Id).ToInt64()
        executablePath = $defaultLaunchState.ExecutablePath
        helperLogLine = $launchLogLine
        interactiveSessionVerified = $true
        hklmRunFallbackVerified = $true
        manualInteractiveGateRequired = $false
      }
      Stop-HualiProcesses
    } else {
      $launchLogLine = Wait-ForNewLaunchLogLine `
        -StartingLineCount $launchLogLineCount `
        -Pattern 'SKIP no-interactive-user'
      Assert-NoHualiProcesses -Stage '无交互会话默认安装'
      $report.checks.defaultLaunch = [ordered]@{
        status = 'non-interactive-fallback-verified'
        executablePath = $defaultLaunchState.ExecutablePath
        helperLogLine = $launchLogLine
        interactiveSessionVerified = $false
        helperNoInteractiveFallbackVerified = $true
        hklmRunFallbackVerified = $true
        processNotStarted = $true
        manualInteractiveGateRequired = $true
        manualCommand = 'powershell.exe -NoProfile -ExecutionPolicy Bypass -File .\Test-HualiAISilentDeployment.ps1 -MsiPath .\<1.0.41.msi> -ExpectedVersion 1.0.41 -ValidateDefaultLaunch -RequireInteractiveDefaultLaunch'
      }
      if ($RequireInteractiveDefaultLaunch) {
        throw '当前 Windows runner 没有 Explorer 交互桌面；默认启动的无用户回退路径已验证，但本次要求的交互真机门禁明确失败。'
      }
      Write-Warning '当前 runner 无 Explorer：已验证辅助程序 SKIP 日志、不误启动进程与 HKLM Run 兜底；仍需在真实登录用户的 Windows 上执行交互默认启动门禁。'
    }
  } elseif ($RunVisualSmoke) {
    Invoke-Install `
      -ResolvedMsi $resolvedMsi `
      -LogPath (Join-Path $resolvedEvidence '04-current-visual-install.log') `
      -DisableLaunch
    $visualInstallState = Assert-InstalledState -Version $ExpectedVersion
    $lastExecutablePath = $visualInstallState.ExecutablePath
  }

  if ($RunVisualSmoke) {
    $visualInteractiveSessions = @(Get-InteractiveExplorerSessions)
    $visualSessionId = [Diagnostics.Process]::GetCurrentProcess().SessionId
    if ($visualSessionId -notin $visualInteractiveSessions) {
      throw "当前 Windows runner 会话 $visualSessionId 没有 Explorer 交互桌面，无法执行真实窗口截图、鼠标交互和 DPI 视觉门禁；本次发布验收明确失败。"
    }
    Assert-NoHualiProcesses -Stage '真实窗口视觉冒烟测试启动前'
    $visualSmokeScript = Join-Path $PSScriptRoot 'Test-HualiAIWindowsVisualSmoke.ps1'
    if (-not (Test-Path -LiteralPath $visualSmokeScript -PathType Leaf)) {
      throw "缺少 Windows 视觉冒烟测试脚本：$visualSmokeScript"
    }
    & $visualSmokeScript `
      -ExecutablePath $lastExecutablePath `
      -OutputDirectory $resolvedVisualEvidence
    Assert-NoHualiProcesses -Stage '真实窗口视觉冒烟测试结束'
    $report.checks.visualSmoke = [ordered]@{
      outputDirectory = $resolvedVisualEvidence
      completed = $true
    }
  }

  $finalProducts = @(Get-InstalledProducts)
  if ($finalProducts.Count -eq 1) {
    Invoke-UninstallProduct `
      -ProductCode ([string]$finalProducts[0].PSChildName) `
      -LogPath (Join-Path $resolvedEvidence '05-final-uninstall.log')
  } elseif ($finalProducts.Count -ne 0) {
    throw "最终卸载前产品登记数量错误：$($finalProducts.Count)。"
  }
  Assert-UninstalledState -Stage '最终静默卸载' -FormerExecutablePath $lastExecutablePath
  $report.checks.finalUninstall = [ordered]@{
    productRegistrationRemoved = $true
    markerRemoved = $true
    runValueRemoved = $true
    executableRemoved = $true
    installDirectoryRemoved = $true
    processRemoved = $true
  }
  $report.ok = $true
  Write-Host '管理员 /qn 覆盖升级、本 runner 可执行的默认启动路径与完整卸载验证全部通过。'
} catch {
  $primaryFailure = $_
  $report.failure = $_.Exception.Message
} finally {
  if ($cleanupAuthorized) {
    try {
      Stop-HualiProcesses
      $cleanupIndex = 0
      foreach ($product in Get-InstalledProducts) {
        $cleanupIndex++
        Invoke-UninstallProduct `
          -ProductCode ([string]$product.PSChildName) `
          -LogPath (Join-Path $resolvedEvidence ("99-emergency-cleanup-$cleanupIndex.log"))
      }
      Assert-UninstalledState -Stage '测试清理' -FormerExecutablePath $lastExecutablePath
      $report.cleanup = [ordered]@{ completed = $true }
    } catch {
      $cleanupFailure = $_
      $report.ok = $false
      if (-not $report.failure) {
        $report.failure = $_.Exception.Message
      }
      $report.cleanup = [ordered]@{
        completed = $false
        failure = $_.Exception.Message
      }
    }
  }

  if (Test-Path -LiteralPath $LaunchLogPath -PathType Leaf) {
    Copy-Item -LiteralPath $LaunchLogPath -Destination (Join-Path $resolvedEvidence 'launch-after-install.log') -Force
  }
  $report.completedAt = [DateTime]::UtcNow.ToString('o')
  $report | ConvertTo-Json -Depth 8 |
    Set-Content -LiteralPath (Join-Path $resolvedEvidence 'deployment-smoke-report.json') -Encoding UTF8
}

if ($primaryFailure) {
  throw $primaryFailure
}
if ($cleanupFailure) {
  throw $cleanupFailure
}
