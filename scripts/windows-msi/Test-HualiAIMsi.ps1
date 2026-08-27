[CmdletBinding()]
param(
  [Parameter(Mandatory = $true)]
  [string]$MsiPath,

  [Parameter(Mandatory = $true)]
  [string]$ExpectedVersion,

  [string]$ExpectedUpgradeCode = '07C9B303-2B8E-48E4-AB16-6EB2FB87DF13',

  [switch]$AllowUnsigned
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

function Invoke-ComMethod {
  param(
    [Parameter(Mandatory = $true)]$Object,
    [Parameter(Mandatory = $true)][string]$Name,
    [object[]]$Arguments = @()
  )

  return $Object.GetType().InvokeMember(
    $Name,
    [Reflection.BindingFlags]::InvokeMethod,
    $null,
    $Object,
    $Arguments
  )
}

function Get-ComProperty {
  param(
    [Parameter(Mandatory = $true)]$Object,
    [Parameter(Mandatory = $true)][string]$Name,
    [object[]]$Arguments = @()
  )

  return $Object.GetType().InvokeMember(
    $Name,
    [Reflection.BindingFlags]::GetProperty,
    $null,
    $Object,
    $Arguments
  )
}

function Get-MsiRows {
  param(
    [Parameter(Mandatory = $true)][string]$Sql,
    [Parameter(Mandatory = $true)][int]$ColumnCount
  )

  $rows = @()
  $view = Invoke-ComMethod -Object $script:Database -Name 'OpenView' -Arguments @($Sql)
  try {
    Invoke-ComMethod -Object $view -Name 'Execute' | Out-Null
    while ($true) {
      $record = Invoke-ComMethod -Object $view -Name 'Fetch'
      if (-not $record) {
        break
      }
      $row = @()
      for ($column = 1; $column -le $ColumnCount; $column++) {
        $row += [string](Get-ComProperty -Object $record -Name 'StringData' -Arguments @($column))
      }
      $rows += [pscustomobject]@{ Values = [object[]]$row }
      [Runtime.InteropServices.Marshal]::FinalReleaseComObject($record) | Out-Null
    }
  } finally {
    try { Invoke-ComMethod -Object $view -Name 'Close' | Out-Null } catch {}
    [Runtime.InteropServices.Marshal]::FinalReleaseComObject($view) | Out-Null
  }
  return $rows
}

function Get-MsiProperty {
  param([Parameter(Mandatory = $true)][string]$Name)

  $sql = 'SELECT `Value` FROM `Property` WHERE `Property` = ''{0}''' -f $Name
  $rows = @(Get-MsiRows -Sql $sql -ColumnCount 1)
  if ($rows.Count -eq 0) {
    return $null
  }
  return [string]$rows[0].Values[0]
}

function Assert-Equal {
  param(
    [Parameter(Mandatory = $true)][string]$Label,
    [AllowNull()][string]$Actual,
    [Parameter(Mandatory = $true)][string]$Expected
  )

  if ($Actual -ne $Expected) {
    throw "$Label 不符合预期：实际='$Actual'，预期='$Expected'"
  }
}

if ($env:OS -ne 'Windows_NT') {
  throw '该验收脚本只能在 Windows 上运行。'
}

$resolvedMsi = (Resolve-Path -LiteralPath $MsiPath).Path
$msiFile = Get-Item -LiteralPath $resolvedMsi
if ($msiFile.Extension -ne '.msi') {
  throw "不是 MSI 文件：$resolvedMsi"
}
if ($msiFile.Length -lt 64MB) {
  throw "MSI 仅 $([Math]::Round($msiFile.Length / 1MB, 1)) MB，疑似未包含离线 WebView2 Runtime。"
}

$installer = New-Object -ComObject WindowsInstaller.Installer
try {
  $script:Database = Invoke-ComMethod -Object $installer -Name 'OpenDatabase' -Arguments @($resolvedMsi, 0)
  try {
    Assert-Equal -Label 'ProductName' -Actual (Get-MsiProperty -Name 'ProductName') -Expected '华力AI桌面助手'
    Assert-Equal -Label 'ProductVersion' -Actual (Get-MsiProperty -Name 'ProductVersion') -Expected $ExpectedVersion
    Assert-Equal -Label 'UpgradeCode' `
      -Actual ((Get-MsiProperty -Name 'UpgradeCode').Trim('{}').ToUpperInvariant()) `
      -Expected ($ExpectedUpgradeCode.Trim('{}').ToUpperInvariant())
    Assert-Equal -Label 'ProductLanguage' -Actual (Get-MsiProperty -Name 'ProductLanguage') -Expected '2052'
    Assert-Equal -Label '安装后启动默认值' -Actual (Get-MsiProperty -Name 'HUALI_START_AFTER_INSTALL') -Expected '1'

    $tables = @(Get-MsiRows -Sql 'SELECT `Name` FROM `_Tables`' -ColumnCount 1 | ForEach-Object { $_.Values[0] })
    foreach ($requiredTable in @('Upgrade', 'Registry', 'Binary', 'CustomAction', 'InstallExecuteSequence', 'WixCloseApplication')) {
      if ($requiredTable -notin $tables) {
        throw "MSI 缺少必需表：$requiredTable"
      }
    }

    $fileNames = @(Get-MsiRows -Sql 'SELECT `FileName` FROM `File`' -ColumnCount 1 | ForEach-Object { $_.Values[0] })
    if (-not ($fileNames | Where-Object { $_ -match '(^|\|)HualiAIDesktopAssistant\.exe$' })) {
      throw 'MSI File 表中没有主程序 HualiAIDesktopAssistant.exe。'
    }
    if (-not ($fileNames | Where-Object { $_ -match '(^|\|)launch-after-install\.ps1$' })) {
      throw 'MSI File 表中没有安装后立即启动脚本。'
    }

    $binaryNames = @(Get-MsiRows -Sql 'SELECT `Name` FROM `Binary`' -ColumnCount 1 | ForEach-Object { $_.Values[0] })
    if ('MicrosoftEdgeWebView2RuntimeInstaller.exe' -notin $binaryNames) {
      throw 'MSI 没有内置离线 WebView2 Runtime 安装程序。'
    }

    $runRows = @(Get-MsiRows -Sql "SELECT ``Root``, ``Key``, ``Value`` FROM ``Registry`` WHERE ``Name`` = '华力AI桌面助手'" -ColumnCount 3)
    if ($runRows.Count -ne 1) {
      throw "全用户登录自启动项数量错误：$($runRows.Count)"
    }
    Assert-Equal -Label '登录自启动注册表根' -Actual $runRows[0].Values[0] -Expected '2'
    Assert-Equal -Label '登录自启动注册表键' `
      -Actual $runRows[0].Values[1] `
      -Expected 'SOFTWARE\Microsoft\Windows\CurrentVersion\Run'
    if ($runRows[0].Values[2] -notmatch 'HualiAIDesktopAssistant\.exe') {
      throw '登录自启动值没有指向主程序。'
    }

    $markerRows = @(Get-MsiRows -Sql "SELECT ``Root``, ``Key``, ``Value`` FROM ``Registry`` WHERE ``Name`` = 'InstallerType'" -ColumnCount 3)
    if (($markerRows.Count -ne 1) -or
        ($markerRows[0].Values[0] -ne '2') -or
        ($markerRows[0].Values[1] -ne 'SOFTWARE\Huali\HualiAIDesktopAssistant') -or
        ($markerRows[0].Values[2] -ne 'MSI')) {
      throw '管理平台的整机安装检测标记缺失或错误。'
    }

    # Windows Installer SQL only implements a small SQL subset and does not
    # support LIKE. Read the Registry table once and filter the protocol rows
    # in PowerShell so the gate works on both Windows PowerShell 5.1 and pwsh.
    $protocolRows = @(Get-MsiRows `
      -Sql 'SELECT `Root`, `Key`, `Name`, `Value` FROM `Registry`' `
      -ColumnCount 4 | Where-Object {
        $_.Values[1] -like 'Software\Classes\huali-ai-mascot*'
      })
    if (-not ($protocolRows | Where-Object {
          $_.Values[0] -eq '2' -and
          $_.Values[1] -ieq 'Software\Classes\huali-ai-mascot' -and
          $_.Values[2] -eq 'URL Protocol'
        })) {
      throw 'MSI 没有包含机器级 huali-ai-mascot URL Protocol 注册。'
    }
    $protocolCommandRows = @($protocolRows | Where-Object {
      $_.Values[0] -eq '2' -and
      $_.Values[1] -ieq 'Software\Classes\huali-ai-mascot\shell\open\command'
    })
    if (($protocolCommandRows.Count -ne 1) -or
        ($protocolCommandRows[0].Values[3] -notmatch '\[!Path\].*%1')) {
      throw 'MSI 的 huali-ai-mascot 协议没有正确指向主程序。'
    }

    $launchCommandRows = @(Get-MsiRows -Sql "SELECT ``Source``, ``Target`` FROM ``CustomAction`` WHERE ``Action`` = 'SetLaunchHualiAfterInstallCommand'" -ColumnCount 2)
    if (($launchCommandRows.Count -ne 1) -or
        ($launchCommandRows[0].Values[0] -ne 'WixQuietExec64CmdLine') -or
        ($launchCommandRows[0].Values[1] -notmatch 'launch-after-install\.ps1')) {
      throw '安装后立即启动的隐藏执行命令缺失或内容错误。'
    }

    $launchRows = @(Get-MsiRows -Sql "SELECT ``Source``, ``Target`` FROM ``CustomAction`` WHERE ``Action`` = 'LaunchHualiAfterInstall'" -ColumnCount 2)
    if (($launchRows.Count -ne 1) -or
        ($launchRows[0].Values[0] -ne 'WixCA') -or
        ($launchRows[0].Values[1] -ne 'WixQuietExec64')) {
      throw '安装后立即启动未使用 WixQuietExec64 隐藏执行。'
    }

    $launchSequenceRows = @(Get-MsiRows -Sql "SELECT ``Condition`` FROM ``InstallExecuteSequence`` WHERE ``Action`` = 'LaunchHualiAfterInstall'" -ColumnCount 1)
    if (($launchSequenceRows.Count -ne 1) -or ($launchSequenceRows[0].Values[0] -notmatch 'HUALI_START_AFTER_INSTALL')) {
      throw '安装后立即启动执行序列缺失或条件错误。'
    }

    $legacyCommandRows = @(Get-MsiRows -Sql "SELECT ``Source``, ``Target`` FROM ``CustomAction`` WHERE ``Action`` = 'SetRemoveLegacyNsisPackageCommand'" -ColumnCount 2)
    if (($legacyCommandRows.Count -ne 1) -or
        ($legacyCommandRows[0].Values[0] -ne 'RemoveLegacyNsisPackage') -or
        ($legacyCommandRows[0].Values[1] -notmatch '^\[LEGACY_NSIS_UNINSTALLER\] /S$')) {
      throw '旧企业 NSIS/EXE 包的静默卸载命令缺失或错误。'
    }

    $legacyRows = @(Get-MsiRows -Sql "SELECT ``Source``, ``Target`` FROM ``CustomAction`` WHERE ``Action`` = 'RemoveLegacyNsisPackage'" -ColumnCount 2)
    if (($legacyRows.Count -ne 1) -or
        ($legacyRows[0].Values[0] -ne 'WixCA') -or
        ($legacyRows[0].Values[1] -ne 'WixQuietExec64')) {
      throw '旧企业 NSIS/EXE 包的静默迁移动作缺失或错误。'
    }

    $cleanupCommandRows = @(Get-MsiRows -Sql "SELECT ``Source``, ``Target`` FROM ``CustomAction`` WHERE ``Action`` = 'SetWaitForLegacyNsisCleanupCommand'" -ColumnCount 2)
    if (($cleanupCommandRows.Count -ne 1) -or
        ($cleanupCommandRows[0].Values[0] -ne 'WaitForLegacyNsisCleanup') -or
        ($cleanupCommandRows[0].Values[1] -notmatch 'ping\.exe')) {
      throw '旧版清理等待命令缺失或内容错误。'
    }

    $cleanupRows = @(Get-MsiRows -Sql "SELECT ``Source``, ``Target`` FROM ``CustomAction`` WHERE ``Action`` = 'WaitForLegacyNsisCleanup'" -ColumnCount 2)
    if (($cleanupRows.Count -ne 1) -or
        ($cleanupRows[0].Values[0] -ne 'WixCA') -or
        ($cleanupRows[0].Values[1] -ne 'WixQuietExec64')) {
      throw '旧版清理等待未使用 WixQuietExec64 隐藏执行。'
    }

    $upgradeRows = @(Get-MsiRows -Sql 'SELECT `UpgradeCode` FROM `Upgrade`' -ColumnCount 1)
    $normalizedUpgradeCode = $ExpectedUpgradeCode.Trim('{}').ToUpperInvariant()
    if (-not ($upgradeRows | Where-Object { $_.Values[0].Trim('{}').ToUpperInvariant() -eq $normalizedUpgradeCode })) {
      throw 'Upgrade 表中没有固定 UpgradeCode，后续版本将无法稳定覆盖。'
    }
  } finally {
    [Runtime.InteropServices.Marshal]::FinalReleaseComObject($script:Database) | Out-Null
    Remove-Variable -Name Database -Scope Script -ErrorAction SilentlyContinue
  }
} finally {
  [Runtime.InteropServices.Marshal]::FinalReleaseComObject($installer) | Out-Null
}

$signature = Get-AuthenticodeSignature -LiteralPath $resolvedMsi
if (-not $AllowUnsigned -and $signature.Status -ne 'Valid') {
  throw "MSI 数字签名无效：$($signature.Status)"
}

Write-Host 'MSI 结构验收通过：'
Write-Host "  文件：$resolvedMsi"
Write-Host "  版本：$ExpectedVersion"
Write-Host "  大小：$([Math]::Round($msiFile.Length / 1MB, 1)) MB"
Write-Host "  签名：$($signature.Status)"
Write-Host '  覆盖升级：已配置'
Write-Host '  安装后立即启动：已配置'
Write-Host '  安装自定义命令：已隐藏执行'
Write-Host '  每次登录 Windows 自动启动：已配置'
