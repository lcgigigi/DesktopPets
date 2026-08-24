import { describe, expect, it } from 'vitest'
import unsignedV1043WorkflowSource from '../../.github/workflows/build-windows-msi-unsigned-v1043.yml?raw'
import visualSmokeSource from '../../scripts/windows-msi/Test-HualiAIWindowsVisualSmoke.ps1?raw'

const FRAME_WIDTH = 120
const FRAME_HEIGHT = 104
const EDGE_WIDTH = 4
const LEGAL_TOP_ROWS = 2
const BACKDROP_RGB = [92, 107, 122] as const
const CHANNEL_TOLERANCE = 3
const MAX_MEAN_CHANNEL_DIFFERENCE = 3
const MIN_MATCHING_FRACTION = 0.98
const MIN_EDGE_MATCHING_FRACTION = 0.95

type Rgb = readonly [number, number, number]
type ProtectedEdge = 'left' | 'right' | 'bottom'

function createFrame(color: Rgb) {
  const pixels = new Uint8ClampedArray(FRAME_WIDTH * FRAME_HEIGHT * 3)
  for (let index = 0; index < FRAME_WIDTH * FRAME_HEIGHT; index++) {
    pixels[index * 3] = color[0]
    pixels[index * 3 + 1] = color[1]
    pixels[index * 3 + 2] = color[2]
  }
  return pixels
}

function setPixel(frame: Uint8ClampedArray, x: number, y: number, color: Rgb) {
  const offset = (y * FRAME_WIDTH + x) * 3
  frame[offset] = color[0]
  frame[offset + 1] = color[1]
  frame[offset + 2] = color[2]
}

function paintRows(frame: Uint8ClampedArray, firstRow: number, rowCount: number, color: Rgb) {
  for (let y = firstRow; y < Math.min(FRAME_HEIGHT, firstRow + rowCount); y++) {
    for (let x = 0; x < FRAME_WIDTH; x++) setPixel(frame, x, y, color)
  }
}

function paintOnePixelLeftRightBottomBorder(frame: Uint8ClampedArray, color: Rgb) {
  for (let y = 0; y < FRAME_HEIGHT; y++) {
    setPixel(frame, 0, y, color)
    setPixel(frame, FRAME_WIDTH - 1, y, color)
  }
  for (let x = 0; x < FRAME_WIDTH; x++) {
    setPixel(frame, x, FRAME_HEIGHT - 1, color)
  }
}

function blendFrameTowardWhite(frame: Uint8ClampedArray, opacity: number) {
  for (let offset = 0; offset < frame.length; offset++) {
    frame[offset] = Math.round(frame[offset] * (1 - opacity) + 255 * opacity)
  }
}

function getThreeEdgeTransparencyMetrics(frame: Uint8ClampedArray, expected: Rgb) {
  expect(frame).toHaveLength(FRAME_WIDTH * FRAME_HEIGHT * 3)

  let channelDifference = 0
  let matchingPixels = 0
  let sampledPixels = 0
  const edgeSamples: Record<ProtectedEdge, number> = { left: 0, right: 0, bottom: 0 }
  const edgeMatches: Record<ProtectedEdge, number> = { left: 0, right: 0, bottom: 0 }
  for (let y = 0; y < FRAME_HEIGHT; y++) {
    for (let x = 0; x < FRAME_WIDTH; x++) {
      const membership: ProtectedEdge[] = []
      // The complete top strip is excluded so a legitimate card may meet the
      // top of the avatar crop. Both sides resume below that strip, and the
      // bottom is always protected.
      if (x < EDGE_WIDTH && y >= EDGE_WIDTH) membership.push('left')
      if (x >= FRAME_WIDTH - EDGE_WIDTH && y >= EDGE_WIDTH) membership.push('right')
      if (y >= FRAME_HEIGHT - EDGE_WIDTH) membership.push('bottom')
      if (membership.length === 0) continue

      const offset = (y * FRAME_WIDTH + x) * 3
      const redDifference = Math.abs(expected[0] - frame[offset])
      const greenDifference = Math.abs(expected[1] - frame[offset + 1])
      const blueDifference = Math.abs(expected[2] - frame[offset + 2])
      const matches = redDifference <= CHANNEL_TOLERANCE
        && greenDifference <= CHANNEL_TOLERANCE
        && blueDifference <= CHANNEL_TOLERANCE
      channelDifference += redDifference + greenDifference + blueDifference
      if (matches) matchingPixels += 1
      for (const edge of membership) {
        edgeSamples[edge] += 1
        if (matches) edgeMatches[edge] += 1
      }
      sampledPixels += 1
    }
  }

  const meanChannelDifference = channelDifference / (sampledPixels * 3)
  const matchingFraction = matchingPixels / sampledPixels
  const changedPixelRatio = 1 - matchingFraction
  const edgeMatchingFractions = Object.fromEntries(
    (Object.keys(edgeSamples) as ProtectedEdge[])
      .map(edge => [edge, edgeMatches[edge] / edgeSamples[edge]]),
  ) as Record<ProtectedEdge, number>
  return {
    sampledPixels,
    matchingFraction,
    meanChannelDifference,
    changedPixelRatio,
    edgeMatchingFractions,
    passes: meanChannelDifference <= MAX_MEAN_CHANNEL_DIFFERENCE
      && matchingFraction >= MIN_MATCHING_FRACTION
      && Object.values(edgeMatchingFractions)
        .every(fraction => fraction >= MIN_EDGE_MATCHING_FRACTION),
  }
}

function normalizedPowerShell() {
  return visualSmokeSource.replace(/\r\n?/g, '\n')
}

function normalizedWorkflow() {
  return unsignedV1043WorkflowSource.replace(/\r\n?/g, '\n')
}

function getWorkflowStep(source: string, name: string) {
  const start = source.indexOf(`      - name: ${name}`)
  const nextStep = source.indexOf('\n      - name:', start + 1)
  return {
    start,
    source: source.slice(start, nextStep === -1 ? source.length : nextStep),
  }
}

describe('Windows visual-smoke fixed backdrop contract', () => {
  it('uses a normal-z-order fixed RGB backdrop on a dedicated STA UI thread', () => {
    const source = normalizedPowerShell()

    expect(source).toMatch(/TopMost\s*=\s*(?:\$false|false)/i)
    expect(source).toMatch(/SetApartmentState\([\s\S]*?ApartmentState\]?(?:::|\.)STA\)/i)
    expect(source).toMatch(/Application\]?(?:::|\.)Run\(/i)
    expect(source).toMatch(/expectedRgb\s*=\s*@\(92,\s*107,\s*122\)/)
    expect(source).toMatch(/Color\.FromArgb\(red,\s*green,\s*blue\)/)
    expect(source).not.toMatch(/TopMost\s*=\s*(?:\$true|true)/i)
  })

  it('pulses above the foreground without activation before returning to normal z-order', () => {
    const source = normalizedPowerShell()
    const classStart = source.indexOf('public sealed class HualiVisualSmokeBackdrop')
    const classEnd = source.indexOf("'@ -ReferencedAssemblies $backdropReferencedAssemblies", classStart)
    const backdropClass = source.slice(classStart, classEnd)
    const shownStart = backdropClass.indexOf('backdrop.Shown += delegate')
    const shownEnd = backdropClass.indexOf('\n                };', shownStart)
    const shown = backdropClass.slice(shownStart, shownEnd)

    expect(classStart).toBeGreaterThanOrEqual(0)
    expect(classEnd).toBeGreaterThan(classStart)
    expect(backdropClass).toMatch(
      /\[DllImport\("user32\.dll", SetLastError = true\)\][\s\S]*?private static extern bool SetWindowPos\(/,
    )
    expect(backdropClass).toContain('private static readonly IntPtr HwndTopmost = new IntPtr(-1);')
    expect(backdropClass).toContain('private static readonly IntPtr HwndNotTopmost = new IntPtr(-2);')
    expect(backdropClass).toContain('private const uint SwpNoSize = 0x0001;')
    expect(backdropClass).toContain('private const uint SwpNoMove = 0x0002;')
    expect(backdropClass).toContain('private const uint SwpNoActivate = 0x0010;')
    expect(shownStart).toBeGreaterThanOrEqual(0)
    expect(shownEnd).toBeGreaterThan(shownStart)
    expect(shown).toContain('uint zOrderFlags = SwpNoSize | SwpNoMove | SwpNoActivate;')

    const topmostPulse = shown.indexOf('HwndTopmost')
    const normalBandPulse = shown.indexOf('HwndNotTopmost')
    const refresh = shown.indexOf('backdrop.Refresh();')
    const ready = shown.indexOf('ready.Set();')

    expect(topmostPulse).toBeGreaterThanOrEqual(0)
    expect(normalBandPulse).toBeGreaterThan(topmostPulse)
    expect(refresh).toBeGreaterThan(normalBandPulse)
    expect(ready).toBeGreaterThan(refresh)
    expect(backdropClass).toContain('backdrop.TopMost = false;')
    expect(backdropClass).not.toMatch(/TopMost\s*=\s*true/i)
  })

  it('uses complete Core reference-pack inputs and runtime Desktop assembly locations', () => {
    const source = normalizedPowerShell()
    const drawingLoad = source.indexOf('Add-Type -AssemblyName System.Drawing')
    const formsLoad = source.indexOf('Add-Type -AssemblyName System.Windows.Forms')
    const coreStart = source.indexOf("if ($PSVersionTable.PSEdition -eq 'Core') {")
    const desktopStart = source.indexOf('} else {', coreStart)
    const backdropTypeStart = source.indexOf("Add-Type -TypeDefinition @'", desktopStart)
    const coreBranch = source.slice(coreStart, desktopStart)
    const desktopBranch = source.slice(desktopStart, backdropTypeStart)
    const backdropDefinition = source.slice(source.indexOf('public sealed class HualiVisualSmokeBackdrop'))
    const backdropAddTypeEnd = backdropDefinition.indexOf('\nfunction Get-WindowSnapshot')
    const backdropAddType = backdropDefinition.slice(0, backdropAddTypeEnd)

    expect(drawingLoad).toBeGreaterThanOrEqual(0)
    expect(formsLoad).toBeGreaterThan(drawingLoad)
    expect(coreStart).toBeGreaterThan(formsLoad)
    expect(desktopStart).toBeGreaterThan(coreStart)
    expect(backdropTypeStart).toBeGreaterThan(desktopStart)
    expect(coreBranch).toContain("$powerShellReferenceDirectory = Join-Path $PSHOME 'ref'")
    expect(coreBranch).toMatch(
      /\$powerShellReferenceAssemblies = @\(\s*Get-ChildItem -LiteralPath \$powerShellReferenceDirectory -Filter '\*\.dll' -File \|\s*ForEach-Object \{ \$_\.FullName \}\s*\)/,
    )
    expect(coreBranch).toMatch(
      /\$windowsDesktopDirectory = \[IO\.Path\]::GetDirectoryName\(\s*\[Windows\.Forms\.Form\]\.Assembly\.Location\s*\)/,
    )
    expect(coreBranch).toContain(
      "Join-Path $windowsDesktopDirectory 'System.Windows.Forms.Primitives.dll'",
    )
    expect(coreBranch).toContain(
      "Join-Path $windowsDesktopDirectory 'System.Private.Windows.Core.dll'",
    )
    expect(coreBranch).toMatch(
      /foreach \(\$windowsDesktopReference in \$windowsDesktopReferenceAssemblies\) \{[\s\S]*?Test-Path -LiteralPath \$windowsDesktopReference -PathType Leaf/,
    )
    expect(coreBranch).toMatch(
      /\$backdropReferencedAssemblies = @\(\s*\$powerShellReferenceAssemblies\s*\[Drawing\.Bitmap\]\.Assembly\.Location\s*\[Windows\.Forms\.Form\]\.Assembly\.Location\s*\$windowsDesktopReferenceAssemblies\s*\) \| Sort-Object -Unique/,
    )
    expect(coreBranch).not.toContain('[Drawing.Rectangle].Assembly.Location')
    expect(desktopBranch).toMatch(
      /\$backdropReferencedAssemblies = @\(\s*\[Drawing\.Bitmap\]\.Assembly\.Location\s*\[Drawing\.Rectangle\]\.Assembly\.Location\s*\[Windows\.Forms\.Form\]\.Assembly\.Location\s*\) \| Sort-Object -Unique/,
    )
    expect(backdropDefinition).toContain('public sealed class HualiVisualSmokeBackdrop')
    expect(backdropAddTypeEnd).toBeGreaterThanOrEqual(0)
    expect(backdropAddType).toContain("'@ -ReferencedAssemblies $backdropReferencedAssemblies")
    expect(source).toMatch(/param\([\s\S]*?\[switch\]\$CompileBackdropOnly[\s\S]*?\)/)
    expect(backdropAddType).toMatch(
      /if \(\$CompileBackdropOnly\) \{[\s\S]*?\[HualiVisualSmokeBackdrop\]::new\([\s\S]*?\)[\s\S]*?return\s*\}/,
    )
  })

  it('shows and verifies the backdrop before the baseline and application startup', () => {
    const source = normalizedPowerShell()
    expect(source).toMatch(
      /thread\.Start\(\);[\s\S]*?ready\.Wait\(TimeSpan\.FromSeconds\(5\)\)/,
    )
    expect(source).toMatch(
      /backdrop\.Shown\s*\+=\s*delegate[\s\S]*?backdrop\.Refresh\(\);[\s\S]*?backdrop\.Update\(\);[\s\S]*?ready\.Set\(\);/,
    )

    const executionStart = source.indexOf('$report = [ordered]@{')
    const execution = source.slice(executionStart)
    const backdropStart = execution.indexOf('$backdrop.Start()')
    const shown = execution.indexOf('$report.backdrop.shown = $true')
    const baseline = execution.indexOf("Save-ScreenCapture -FileName '00-background-baseline.png'")
    const backdropMetrics = execution.indexOf('$backdropBaselineMetrics = Get-FixedBackdropRegionMetrics')
    const reportedMetrics = execution.indexOf('$report.backdrop.baselineMetrics = $backdropBaselineMetrics')
    const backdropAssert = execution.indexOf('Assert-FixedBackdropRegion -Metrics $backdropBaselineMetrics')
    const verified = execution.indexOf('$report.backdrop.backgroundVerified = $true')
    const applicationStart = execution.indexOf('Start-Process -FilePath $resolvedExecutable')

    expect(executionStart).toBeGreaterThanOrEqual(0)
    expect(backdropStart).toBeGreaterThanOrEqual(0)
    expect(shown).toBeGreaterThan(backdropStart)
    expect(baseline).toBeGreaterThan(shown)
    expect(backdropMetrics).toBeGreaterThan(baseline)
    expect(reportedMetrics).toBeGreaterThan(backdropMetrics)
    expect(backdropAssert).toBeGreaterThan(reportedMetrics)
    expect(verified).toBeGreaterThan(backdropAssert)
    expect(applicationStart).toBeGreaterThan(verified)
  })

  it('closes and joins the backdrop in finally without blocking isolated UDF cleanup', () => {
    const source = normalizedPowerShell()
    const outerFinally = source.lastIndexOf('} finally {')
    const finalSection = source.slice(outerFinally)

    expect(outerFinally).toBeGreaterThanOrEqual(0)
    expect(source).toMatch(
      /public void CloseAndWait\(\)[\s\S]*?currentThread\.Join\(TimeSpan\.FromSeconds\(5\)\)/,
    )
    expect(finalSection).toContain('$backdrop.CloseAndWait()')
    expect(finalSection).toContain('Remove-VisualSmokeDataDirectory -Path $visualSmokeDataDirectory')
    expect(finalSection).toMatch(
      /if \(\$backdrop\)\s*\{\s*try\s*\{[\s\S]*?\$backdrop\.CloseAndWait\(\)[\s\S]*?\$report\.backdrop\.disposed = \$true[\s\S]*?\}\s*catch\s*\{[\s\S]*?\}\s*\}\s*if \(\$visualSmokeDataDirectory\)\s*\{\s*try\s*\{[\s\S]*?Remove-VisualSmokeDataDirectory -Path \$visualSmokeDataDirectory/,
    )
    expect(finalSection.indexOf('$backdrop.CloseAndWait()')).toBeLessThan(
      finalSection.indexOf('Remove-VisualSmokeDataDirectory -Path $visualSmokeDataDirectory'),
    )
  })

  it('checks known RGB before launch and both obscured and unobscured avatar edges', () => {
    const source = normalizedPowerShell()

    expect(source).toMatch(/\$animationRegionWidth\s*=\s*\[int\]\[Math\]::Round\(120 \* \$scale\)/)
    expect(source).toMatch(/\$animationRegionHeight\s*=\s*\[int\]\[Math\]::Round\(104 \* \$scale\)/)
    expect(source).toMatch(/\$edgeBorder\s*=.*?\[Math\]::Round\(4 \* \$scale\)/)
    expect(source).toContain('$onLeft = $x -lt $Border -and ($IncludeTop -or $y -ge $Border)')
    expect(source).toContain('$onRight = $x -ge ($frame.Width - $Border) -and ($IncludeTop -or $y -ge $Border)')
    expect(source).toContain('$onBottom = $y -ge ($frame.Height - $Border)')
    expect(source).toContain('$onTop = $IncludeTop -and $y -lt $Border')
    expect(source).toContain('$Metrics.matchingFraction -lt 0.98')
    expect(source).toContain('$Metrics.meanChannelDifference -gt 3')
    expect(source).toContain('Where-Object { [double]$_.Value -lt 0.95 }')
    expect(source).toContain("FileName ('animation\\idle-{0:d2}.png' -f $frameIndex)")
    expect(source).toContain("FileName 'animation\\transparency-menu-open-four-edges.png'")

    const execution = source.slice(source.indexOf('$report = [ordered]@{'))
    const animationLoopStart = execution.indexOf('for ($frameIndex = 1; $frameIndex -le 29; $frameIndex++)')
    const animationLoopEnd = execution.indexOf('$uniqueAnimationFrames =')
    const fourEdgeStart = execution.indexOf('$menuAvatarTransparency = Get-TransparentEdgeMetrics')
    const fourEdgeEnd = execution.indexOf('$report.checks.transparencyMenuOpen = $menuAvatarTransparency')

    expect(animationLoopStart).toBeGreaterThanOrEqual(0)
    expect(animationLoopEnd).toBeGreaterThan(animationLoopStart)
    expect(execution.slice(animationLoopStart, animationLoopEnd)).toContain('Get-TransparentEdgeMetrics')
    expect(execution.slice(animationLoopStart, animationLoopEnd)).toContain('Assert-TransparentEdgeMetrics')
    expect(execution.slice(animationLoopStart, animationLoopEnd)).not.toContain('-IncludeTop')
    expect(execution).toContain('transparencyFrames = $animationTransparencyFrames')
    expect(fourEdgeStart).toBeGreaterThan(animationLoopEnd)
    expect(fourEdgeEnd).toBeGreaterThan(fourEdgeStart)
    expect(execution.slice(fourEdgeStart, fourEdgeEnd)).toContain('-IncludeTop')
  })

  it('repeats detached-notification hide/show and probes the old rectangle for click-through', () => {
    const source = normalizedPowerShell()
    const cycleStart = source.indexOf('for ($cycle = 1; $cycle -le 6; $cycle++)')
    const cycleEnd = source.indexOf('$report.checks.repeatedNotificationHitTesting', cycleStart)
    const cycle = source.slice(cycleStart, cycleEnd)

    expect(source).toContain('Test-WindowOwnLogicalSize -Window $_ -LogicalWidth 320 -LogicalHeight 176')
    expect(source).toContain('[Math]::Abs($mascotLogicalWidth - 120)')
    expect(source).toContain('[Math]::Abs($mascotLogicalHeight - 104)')
    expect(cycleStart).toBeGreaterThanOrEqual(0)
    expect(cycleEnd).toBeGreaterThan(cycleStart)
    expect(cycle).toContain('Find-WindowByHandle -Windows $windows -Handle $authHandle')
    expect(cycle).toContain('[HualiVisualSmokeNative]::RootWindowFromPoint($probeX, $probeY)')
    expect(cycle).toContain('$probeRoot -ne $backdropHandle')
    expect(cycle).toContain('clickThrough = $true')
  })
})

describe('Windows v1.0.43 workflow visual-gate compiler contract', () => {
  it('compiles the gate in PowerShell 7 and 5.1 before Node and Rust setup', () => {
    const workflow = normalizedWorkflow()
    const powerShell7 = getWorkflowStep(workflow, 'Compile visual gate with PowerShell 7')
    const windowsPowerShell = getWorkflowStep(
      workflow,
      'Compile visual gate with Windows PowerShell 5.1',
    )
    const nodeSetup = getWorkflowStep(workflow, 'Set up Node.js')
    const rustSetup = getWorkflowStep(workflow, 'Set up stable Rust MSVC')
    const compileCommand = '& .\\scripts\\windows-msi\\Test-HualiAIWindowsVisualSmoke.ps1 -CompileBackdropOnly'

    expect(powerShell7.start).toBeGreaterThanOrEqual(0)
    expect(windowsPowerShell.start).toBeGreaterThan(powerShell7.start)
    expect(nodeSetup.start).toBeGreaterThan(windowsPowerShell.start)
    expect(rustSetup.start).toBeGreaterThan(nodeSetup.start)
    expect(powerShell7.source).toMatch(/\n\s+shell: pwsh\s*\n/)
    expect(windowsPowerShell.source).toMatch(/\n\s+shell: powershell\s*\n/)
    expect(powerShell7.source).toContain(compileCommand)
    expect(windowsPowerShell.source).toContain(compileCommand)
  })

  it('runs the live HWND and mouse-interaction gate before publishing the MSI', () => {
    const workflow = normalizedWorkflow()
    const deployment = getWorkflowStep(
      workflow,
      'Smoke-test administrator deployment, upgrade, and live HWND interaction',
    )
    const upload = getWorkflowStep(workflow, 'Upload administrator distribution package')

    expect(deployment.start).toBeGreaterThanOrEqual(0)
    expect(upload.start).toBeGreaterThan(deployment.start)
    expect(deployment.source).toContain('-ValidateDefaultLaunch `')
    expect(deployment.source).toContain('-RunVisualSmoke `')
  })
})

describe('Windows visual-smoke three-edge transparency reference cases', () => {
  const white = [255, 255, 255] as const

  it('accepts a fully transparent 120x104 composite', () => {
    const frame = createFrame(BACKDROP_RGB)
    expect(getThreeEdgeTransparencyMetrics(frame, BACKDROP_RGB)).toMatchObject({ passes: true })
  })

  it('accepts two legal card rows touching only the excluded top edge', () => {
    const frame = createFrame(BACKDROP_RGB)
    paintRows(frame, 0, LEGAL_TOP_ROWS, white)
    expect(getThreeEdgeTransparencyMetrics(frame, BACKDROP_RGB)).toMatchObject({ passes: true })
  })

  it('rejects a full white window background', () => {
    const metrics = getThreeEdgeTransparencyMetrics(createFrame(white), BACKDROP_RGB)
    expect(metrics.passes).toBe(false)
    expect(metrics.changedPixelRatio).toBe(1)
  })

  it('rejects a one-pixel white edge on the left, right and bottom', () => {
    const frame = createFrame(BACKDROP_RGB)
    paintOnePixelLeftRightBottomBorder(frame, white)
    const metrics = getThreeEdgeTransparencyMetrics(frame, BACKDROP_RGB)
    expect(metrics.passes).toBe(false)
    expect(metrics.edgeMatchingFractions.left).toBeLessThan(MIN_EDGE_MATCHING_FRACTION)
    expect(metrics.edgeMatchingFractions.right).toBeLessThan(MIN_EDGE_MATCHING_FRACTION)
    expect(metrics.edgeMatchingFractions.bottom).toBeLessThan(MIN_EDGE_MATCHING_FRACTION)
  })

  it('rejects a uniform four-percent white fog', () => {
    const frame = createFrame(BACKDROP_RGB)
    blendFrameTowardWhite(frame, 0.04)
    const metrics = getThreeEdgeTransparencyMetrics(frame, BACKDROP_RGB)
    expect(metrics.passes).toBe(false)
    expect(metrics.meanChannelDifference).toBeGreaterThan(MAX_MEAN_CHANNEL_DIFFERENCE)
  })
})
