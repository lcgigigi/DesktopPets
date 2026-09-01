[CmdletBinding()]
param(
  [string]$OutputDirectory,

  [string]$ProfileName
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

function Test-IsAdministrator {
  $identity = [Security.Principal.WindowsIdentity]::GetCurrent()
  $principal = New-Object Security.Principal.WindowsPrincipal($identity)
  return $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
}

function Get-OptionalPropertyValue {
  param(
    [Parameter(Mandatory = $true)]
    [object]$InputObject,

    [Parameter(Mandatory = $true)]
    [string]$Name
  )

  if ($InputObject.PSObject.Properties.Name -contains $Name) {
    return $InputObject.$Name
  }
  return $null
}

if ($env:OS -ne 'Windows_NT') {
  throw '该脚本只能在 Windows 上运行。'
}
if (-not (Test-IsAdministrator)) {
  throw '请由管理平台以管理员或 SYSTEM 身份运行该脚本。'
}

if (-not $OutputDirectory) {
  $OutputDirectory = Join-Path $env:ProgramData 'HualiAI\Diagnostics'
}
New-Item -ItemType Directory -Path $OutputDirectory -Force | Out-Null
$resolvedOutputDirectory = (Resolve-Path -LiteralPath $OutputDirectory).Path

$collectionTimestamp = Get-Date -Format 'yyyyMMdd-HHmmss'
$computerLabel = if ($env:COMPUTERNAME) { $env:COMPUTERNAME } else { 'unknown-computer' }
$archivePath = Join-Path $resolvedOutputDirectory "HualiAI-diagnostics-$computerLabel-$collectionTimestamp.zip"
$stagingDirectory = Join-Path $resolvedOutputDirectory ('.staging-' + [guid]::NewGuid().ToString('N'))
New-Item -ItemType Directory -Path $stagingDirectory -Force | Out-Null

$collectedFiles = New-Object System.Collections.Generic.List[object]
$profileRecords = New-Object System.Collections.Generic.List[object]
$profiles = @(
  Get-CimInstance -ClassName Win32_UserProfile |
    Where-Object {
      -not $_.Special -and
      $_.LocalPath -and
      (Test-Path -LiteralPath $_.LocalPath) -and
      (-not $ProfileName -or (Split-Path -Leaf $_.LocalPath) -ieq $ProfileName)
    } |
    Sort-Object LocalPath
)

try {
  $profileIndex = 0
  foreach ($profile in $profiles) {
    $profileIndex += 1
    $resolvedProfileName = Split-Path -Leaf $profile.LocalPath
    $diagnosticDirectory = Join-Path $profile.LocalPath 'AppData\Local\com.huali.ai.mascot\logs'
    $profileFileCount = 0

    foreach ($fileName in @('desktop-diagnostic.jsonl', 'desktop-diagnostic.jsonl.1')) {
      $sourcePath = Join-Path $diagnosticDirectory $fileName
      if (-not (Test-Path -LiteralPath $sourcePath -PathType Leaf)) {
        continue
      }

      $sourceFile = Get-Item -LiteralPath $sourcePath
      $destinationName = 'profile-{0:D3}-{1}' -f $profileIndex, $fileName
      Copy-Item -LiteralPath $sourceFile.FullName -Destination (Join-Path $stagingDirectory $destinationName) -Force
      $profileFileCount += 1
      $collectedFiles.Add([ordered]@{
        profileIndex = $profileIndex
        fileName = $fileName
        copiedAs = $destinationName
        length = $sourceFile.Length
        lastWriteTimeUtc = $sourceFile.LastWriteTimeUtc.ToString('o')
      })
    }

    $profileRecords.Add([ordered]@{
      profileIndex = $profileIndex
      profileName = $resolvedProfileName
      diagnosticFiles = $profileFileCount
    })
  }

  $installedVersion = $null
  $installKey = Get-ItemProperty -LiteralPath 'HKLM:\SOFTWARE\Huali\HualiAIDesktopAssistant' -ErrorAction SilentlyContinue
  if ($installKey) {
    $installedVersion = Get-OptionalPropertyValue -InputObject $installKey -Name 'Version'
  }

  $runningProcesses = @(
    Get-Process -Name 'HualiAIDesktopAssistant' -ErrorAction SilentlyContinue |
      ForEach-Object {
        $startTimeUtc = $null
        try {
          $startTimeUtc = $_.StartTime.ToUniversalTime().ToString('o')
        } catch {
          $startTimeUtc = $null
        }
        [ordered]@{
          processId = $_.Id
          sessionId = $_.SessionId
          startTimeUtc = $startTimeUtc
        }
      }
  )

  $manifest = [ordered]@{
    collectedAtUtc = [DateTime]::UtcNow.ToString('o')
    computerName = $computerLabel
    collectorIdentity = [Security.Principal.WindowsIdentity]::GetCurrent().Name
    installedVersion = $installedVersion
    requestedProfileName = if ($ProfileName) { $ProfileName } else { $null }
    profiles = @($profileRecords)
    runningProcesses = $runningProcesses
    files = @($collectedFiles)
    sensitiveDataPolicy = '日志由应用侧脱敏；收集脚本不读取浏览器存储、token、callback URL 或一次性 state。'
  }
  $manifest | ConvertTo-Json -Depth 6 | Set-Content -LiteralPath (Join-Path $stagingDirectory 'collection-manifest.json') -Encoding UTF8

  Compress-Archive -Path (Join-Path $stagingDirectory '*') -DestinationPath $archivePath -CompressionLevel Optimal -Force
} finally {
  if (Test-Path -LiteralPath $stagingDirectory) {
    Remove-Item -LiteralPath $stagingDirectory -Recurse -Force
  }
}

if ($collectedFiles.Count -eq 0) {
  [Console]::Error.WriteLine("未找到桌面诊断日志；清单已生成：$archivePath")
  exit 2
}

Write-Output $archivePath
exit 0
