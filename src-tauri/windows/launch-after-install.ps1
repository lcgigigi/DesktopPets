[CmdletBinding()]
param(
  [Parameter(Mandatory = $true)]
  [string]$ExecutablePath
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

function Write-LaunchLog {
  param([Parameter(Mandatory = $true)][string]$Message)

  try {
    $logDirectory = Join-Path $env:ProgramData 'HualiAI\Logs'
    New-Item -ItemType Directory -Path $logDirectory -Force | Out-Null
    $line = '{0} {1}' -f (Get-Date -Format 'yyyy-MM-dd HH:mm:ss.fff'), $Message
    Add-Content -LiteralPath (Join-Path $logDirectory 'launch-after-install.log') -Value $line -Encoding UTF8
  } catch {
    # Launch logging must never turn a successful installation into a failure.
  }
}

try {
  if (-not (Test-Path -LiteralPath $ExecutablePath)) {
    Write-LaunchLog "SKIP executable-not-found path=$ExecutablePath"
    exit 0
  }

  $interactiveUsers = @{}
  Get-CimInstance Win32_Process -Filter "Name='explorer.exe'" -ErrorAction SilentlyContinue | ForEach-Object {
    $owner = Invoke-CimMethod -InputObject $_ -MethodName GetOwner -ErrorAction SilentlyContinue
    if ($owner -and ($owner.ReturnValue -eq 0) -and $owner.User) {
      $account = if ($owner.Domain) { "$($owner.Domain)\$($owner.User)" } else { $owner.User }
      $interactiveUsers[$account] = $true
    }
  }

  if ($interactiveUsers.Count -eq 0) {
    Write-LaunchLog 'SKIP no-interactive-user (HKLM Run will start the app at next Windows logon)'
    exit 0
  }

  foreach ($account in $interactiveUsers.Keys) {
    $taskName = "HualiAI-Launch-$([Guid]::NewGuid().ToString('N'))"
    try {
      $action = New-ScheduledTaskAction `
        -Execute $ExecutablePath `
        -WorkingDirectory (Split-Path -Parent $ExecutablePath)
      $principal = New-ScheduledTaskPrincipal `
        -UserId $account `
        -LogonType Interactive `
        -RunLevel Limited
      $task = New-ScheduledTask -Action $action -Principal $principal
      Register-ScheduledTask -TaskName $taskName -InputObject $task -Force | Out-Null
      Start-ScheduledTask -TaskName $taskName
      Start-Sleep -Milliseconds 1500
      Write-LaunchLog "STARTED account=$account path=$ExecutablePath"
    } catch {
      Write-LaunchLog "FAILED account=$account error=$($_.Exception.Message)"
    } finally {
      Unregister-ScheduledTask -TaskName $taskName -Confirm:$false -ErrorAction SilentlyContinue
    }
  }
} catch {
  Write-LaunchLog "FAILED unhandled-error=$($_.Exception.Message)"
}

exit 0
