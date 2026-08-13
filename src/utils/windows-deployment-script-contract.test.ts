import { describe, expect, it } from 'vitest'
import deploymentSmokeSource from '../../scripts/windows-msi/Test-HualiAISilentDeployment.ps1?raw'
import visualSmokeSource from '../../scripts/windows-msi/Test-HualiAIWindowsVisualSmoke.ps1?raw'
import rustSource from '../../src-tauri/src/main.rs?raw'

describe('Windows administrator deployment smoke contracts', () => {
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
