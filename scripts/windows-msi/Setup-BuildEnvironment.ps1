[CmdletBinding()]
param(
  [string]$InstallRoot = 'C:\HualiBuildTools'
)

$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
[Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12

$downloads = Join-Path $InstallRoot 'Downloads'
New-Item -ItemType Directory -Force -Path $downloads | Out-Null

function Get-Tool {
  param(
    [Parameter(Mandatory = $true)][string]$Url,
    [Parameter(Mandatory = $true)][string]$Path,
    [Parameter(Mandatory = $true)][long]$MinimumBytes
  )

  if ((Test-Path $Path) -and ((Get-Item $Path).Length -ge $MinimumBytes)) {
    Write-Host "DOWNLOAD_CACHED $Path"
    return
  }

  Write-Host "DOWNLOAD_START $Url"
  $client = New-Object System.Net.WebClient
  $client.DownloadFile($Url, $Path)
  $length = (Get-Item $Path).Length
  if ($length -lt $MinimumBytes) {
    throw "Downloaded file is unexpectedly small: $Path ($length bytes)"
  }
  Write-Host "DOWNLOAD_DONE $Path $length"
}

$nodeMsi = Join-Path $downloads 'node-v20.19.4-x64.msi'
$rustupExe = Join-Path $downloads 'rustup-init.exe'
$vsExe = Join-Path $downloads 'vs_buildtools_2019.exe'

Get-Tool -Url 'https://nodejs.org/dist/v20.19.4/node-v20.19.4-x64.msi' -Path $nodeMsi -MinimumBytes 20000000
Get-Tool -Url 'https://win.rustup.rs/x86_64' -Path $rustupExe -MinimumBytes 5000000
Get-Tool -Url 'https://aka.ms/vs/16/release/vs_buildtools.exe' -Path $vsExe -MinimumBytes 1000000

Write-Host 'NODE_INSTALL_START'
$process = Start-Process msiexec.exe -ArgumentList @(
  '/i',
  $nodeMsi,
  '/qn',
  '/norestart',
  '/L*v',
  (Join-Path $InstallRoot 'node-install.log')
) -Wait -PassThru
Write-Host "NODE_INSTALL_EXIT $($process.ExitCode)"
if ($process.ExitCode -notin @(0, 3010, 1641)) {
  throw "Node.js installation failed: $($process.ExitCode)"
}

Write-Host 'VS_INSTALL_START'
$vsArguments = @(
  '--quiet',
  '--wait',
  '--norestart',
  '--nocache',
  '--installPath',
  (Join-Path $InstallRoot 'VS2019'),
  '--add',
  'Microsoft.VisualStudio.Workload.VCTools',
  '--add',
  'Microsoft.VisualStudio.Component.Windows10SDK.19041',
  '--includeRecommended'
)
$process = Start-Process $vsExe -ArgumentList $vsArguments -Wait -PassThru
Write-Host "VS_INSTALL_EXIT $($process.ExitCode)"
if ($process.ExitCode -notin @(0, 3010, 1641)) {
  throw "Visual Studio Build Tools installation failed: $($process.ExitCode)"
}

Write-Host 'RUST_INSTALL_START'
$env:CARGO_HOME = Join-Path $InstallRoot 'Cargo'
$env:RUSTUP_HOME = Join-Path $InstallRoot 'Rustup'
$process = Start-Process $rustupExe -ArgumentList @(
  '-y',
  '--default-host',
  'x86_64-pc-windows-msvc',
  '--default-toolchain',
  'stable',
  '--profile',
  'minimal',
  '--no-modify-path'
) -Wait -PassThru -NoNewWindow
Write-Host "RUST_INSTALL_EXIT $($process.ExitCode)"
if ($process.ExitCode -ne 0) {
  throw "Rust installation failed: $($process.ExitCode)"
}

[Environment]::SetEnvironmentVariable('CARGO_HOME', $env:CARGO_HOME, 'Machine')
[Environment]::SetEnvironmentVariable('RUSTUP_HOME', $env:RUSTUP_HOME, 'Machine')

$machinePath = [Environment]::GetEnvironmentVariable('Path', 'Machine')
$requiredPaths = @(
  'C:\Program Files\nodejs',
  (Join-Path $env:CARGO_HOME 'bin')
)
foreach ($requiredPath in $requiredPaths) {
  if (($machinePath -split ';') -notcontains $requiredPath) {
    $machinePath = "$machinePath;$requiredPath"
  }
}
[Environment]::SetEnvironmentVariable('Path', $machinePath, 'Machine')

Write-Host 'VERIFY'
& 'C:\Program Files\nodejs\node.exe' --version
& 'C:\Program Files\nodejs\npm.cmd' --version
& (Join-Path $env:CARGO_HOME 'bin\rustc.exe') --version
& (Join-Path $env:CARGO_HOME 'bin\cargo.exe') --version

$vswhere = "${env:ProgramFiles(x86)}\Microsoft Visual Studio\Installer\vswhere.exe"
if (-not (Test-Path $vswhere)) {
  throw 'vswhere.exe was not installed.'
}
$visualStudioPath = & $vswhere -products * -requires Microsoft.VisualStudio.Component.VC.Tools.x86.x64 -property installationPath
if (-not $visualStudioPath) {
  throw 'Visual Studio C++ x64 tools were not detected.'
}
Write-Host "VS_PATH $visualStudioPath"
Write-Host 'TOOLCHAIN_READY'
