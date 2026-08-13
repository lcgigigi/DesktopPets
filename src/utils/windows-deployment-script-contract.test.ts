import { describe, expect, it } from 'vitest'
import deploymentSmokeSource from '../../scripts/windows-msi/Test-HualiAISilentDeployment.ps1?raw'
import visualSmokeSource from '../../scripts/windows-msi/Test-HualiAIWindowsVisualSmoke.ps1?raw'

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

  it('forces motion only for the visual child process and restores the host environment', () => {
    const normalized = visualSmokeSource.replace(/\r\n?/g, '\n')

    expect(normalized).toContain("webViewMotionOverride = '--force-prefers-no-reduced-motion'")
    expect(normalized).toContain("'WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS'")
    expect(normalized).toContain('$visualWebViewArguments')
    expect(normalized).toMatch(
      /SetEnvironmentVariable\([\s\S]*?\$visualWebViewArguments[\s\S]*?Start-Process[\s\S]*?finally\s*\{[\s\S]*?SetEnvironmentVariable\([\s\S]*?\$previousWebViewArguments/
    )
  })
})
