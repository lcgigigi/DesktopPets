import { describe, expect, it } from 'vitest'
import msiValidationSource from '../../scripts/windows-msi/Test-HualiAIMsi.ps1?raw'
import deploymentSmokeSource from '../../scripts/windows-msi/Test-HualiAISilentDeployment.ps1?raw'
import visualSmokeSource from '../../scripts/windows-msi/Test-HualiAIWindowsVisualSmoke.ps1?raw'
import rustSource from '../../src-tauri/src/main.rs?raw'

describe('Windows administrator deployment smoke contracts', () => {
  it('requires the machine-wide desktop authentication callback protocol throughout MSI lifecycle gates', () => {
    const msiValidation = msiValidationSource.replace(/\r\n?/g, '\n')
    const deployment = deploymentSmokeSource.replace(/\r\n?/g, '\n')

    expect(msiValidation).toContain("Software\\Classes\\huali-ai-mascot")
    expect(msiValidation).toContain("-Sql 'SELECT `Root`, `Key`, `Name`, `Value` FROM `Registry`'")
    expect(msiValidation).not.toMatch(/FROM ``Registry`` WHERE ``Key`` LIKE/)
    expect(msiValidation).toContain("$_.Values[2] -eq 'URL Protocol'")
    expect(msiValidation).toContain("Software\\Classes\\huali-ai-mascot\\shell\\open\\command")
    expect(msiValidation).toContain("-notmatch '\\[!Path\\].*%1'")
    expect(deployment).toContain("$ProtocolSubKey = 'SOFTWARE\\Classes\\huali-ai-mascot'")
    expect(deployment).toContain("[regex]::Match($command, '^\\s*\"(?<executable>[^\"]+)\"\\s+\"%1\"\\s*$')")
    expect(deployment).toContain('$registeredHash = (Get-FileHash -LiteralPath $registeredExecutablePath -Algorithm SHA256).Hash')
    expect(deployment).toContain('$expectedHash = (Get-FileHash -LiteralPath $ExpectedExecutablePath -Algorithm SHA256).Hash')
    expect(deployment).toContain('Assert-DesktopAuthProtocol -ExpectedExecutablePath $installedExecutablePath')
    expect(deployment).toContain('function Invoke-DesktopAuthProtocolCallbackSmoke')
    expect(deployment).toContain('Start-Process -FilePath $callbackUrl')
    expect(deployment).toContain('$existingProcess = Start-Process -FilePath $ExpectedExecutablePath -PassThru')
    expect(deployment).toContain('smokeNonce=$nonce')
    expect(deployment).toContain('forwardedToRunningInstance')
    expect(deployment).toContain('rendererReceived')
    expect(deployment).toContain('singleInstancePreserved = $true')
    expect(deployment).toContain('$report.checks.desktopAuthProtocolCallback = Invoke-DesktopAuthProtocolCallbackSmoke `')
    expect(deployment).toContain('tokenValueRecorded = $false')
    expect(deployment).toContain('Assert-NoDesktopAuthProtocol -Stage $Stage')

    const nativeMain = rustSource.replace(/\r\n?/g, '\n')
    expect(nativeMain).toContain('desktop_auth_callback_query_value(callback_url, "smokeNonce")')
    expect(nativeMain).toContain('"hasState".to_owned()')
    expect(nativeMain).toContain('"hasToken".to_owned()')
    expect(nativeMain).toContain('"hasUserId".to_owned()')
    expect(nativeMain).toContain('"forwardedToRunningInstance".to_owned()')
    expect(nativeMain).toContain('"rendererReceived".to_owned()')
    expect(nativeMain).toContain('record_desktop_auth_renderer_receipt')
    expect(nativeMain).toContain('Receipt is not authentication')
    expect(nativeMain).not.toMatch(
      /if let Some\(callback_url\) = single_instance_desktop_auth\.capture[\s\S]{0,700}hide_mascot_system_notification_native_window\(app\)/
    )
    expect(nativeMain).not.toContain('"tokenValue"')
  })

  it('keeps zero, one and many PowerShell results array-shaped under StrictMode', () => {
    const normalized = deploymentSmokeSource.replace(/\r\n?/g, '\n')

    expect(normalized).toContain('@(Get-HualiProcesses).Count -gt 0')
    expect(normalized.match(/\$processes\s*=\s*@\(Get-HualiProcesses\)/g)).toHaveLength(1)
    expect(normalized.match(/\$products\s*=\s*@\(Get-InstalledProducts\)/g)).toHaveLength(2)
    expect(normalized.match(/\$interactiveSessions\s*=\s*@\(Get-InteractiveExplorerSessions\)/g)).toHaveLength(1)
    expect(normalized.match(/\$visualInteractiveSessions\s*=\s*@\(Get-InteractiveExplorerSessions\)/g)).toHaveLength(1)
    expect(normalized.match(/\$finalProducts\s*=\s*@\(Get-InstalledProducts\)/g)).toHaveLength(1)

    expect(normalized).not.toMatch(
      /(?<!@)\(Get-(?:InstalledProducts|HualiProcesses|InteractiveExplorerSessions)\)\.Count/
    )
  })

  it('uses isolated programmatic WebView2 options only for the visual child process', () => {
    const normalized = visualSmokeSource.replace(/\r\n?/g, '\n')

    expect(normalized).toContain("mode = 'programmatic-webview2-options'")
    expect(normalized).toContain('requested = $false')
    expect(normalized).toContain('isolatedDataDirectoryConfigured = $false')
    expect(normalized).toContain('isolatedDataDirectoryRemoved = $false')
    expect(normalized).toContain('animationProgressionObserved = $false')
    expect(normalized).toContain('$report.motionValidation.animationProgressionObserved = $true')
    expect(normalized).toContain("'HUALI_AI_VISUAL_SMOKE_FORCE_MOTION'")
    expect(normalized).toContain('$previousVisualSmokeMotion')
    expect(normalized).toMatch(
      /SetEnvironmentVariable\([\s\S]*?'1'[\s\S]*?Start-Process[\s\S]*?finally\s*\{[\s\S]*?SetEnvironmentVariable\([\s\S]*?\$previousVisualSmokeMotion/
    )
    expect(normalized.match(/EnvironmentVariableTarget]::Process/g)).toHaveLength(3)
    expect(normalized).toContain('"huali-ai-visual-smoke-$($process.Id)"')
    expect(normalized).toContain('Remove-VisualSmokeDataDirectory -Path $visualSmokeDataDirectory')
    expect(normalized).toContain('$report.motionValidation.isolatedDataDirectoryRemoved = $true')
    expect(normalized).toContain('if ($cleanupFailure)')
    expect(normalized).toContain('Stop-Process -Id $process.Id -Force -ErrorAction Stop')
    expect(normalized).toContain('if (-not $process.WaitForExit(5000))')
    expect(normalized).toContain('if (-not $process.HasExited)')
    expect(normalized).not.toContain('WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS')
    expect(normalized).not.toContain('--force-prefers-no-reduced-motion')

    const nativeMain = rustSource.replace(/\r\n?/g, '\n')
    expect(nativeMain).toContain('std::env::var("HUALI_AI_VISUAL_SMOKE_FORCE_MOTION")')
    expect(nativeMain).toMatch(/\.as_deref\(\),\s*Ok\("1"\)/)
    expect(nativeMain).toContain('--force-prefers-no-reduced-motion')
    expect(nativeMain).toContain('--disable-features=msWebOOUI,msPdfOOUI,msSmartScreenProtection')
    expect(nativeMain).toContain('--autoplay-policy=no-user-gesture-required')
    expect(nativeMain).toContain('window.additional_browser_args = Some(')
    expect(nativeMain).toContain('window.create = false')
    expect(nativeMain).toContain('WebviewWindowBuilder::from_config(')
    expect(nativeMain).toContain('.data_directory(visual_smoke_data_directory.clone())')
    expect(nativeMain).not.toContain('window.data_directory = Some(')
    expect(nativeMain).toContain('huali-ai-visual-smoke-{}')
    expect(nativeMain).toContain('.run(context)')
    expect(nativeMain).not.toContain('.run(tauri::generate_context!())')
  })
})
