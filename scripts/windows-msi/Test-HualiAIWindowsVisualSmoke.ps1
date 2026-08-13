[CmdletBinding()]
param(
  [Parameter(Mandatory = $true)]
  [string]$ExecutablePath,

  [Parameter(Mandatory = $true)]
  [string]$OutputDirectory
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

if ($env:OS -ne 'Windows_NT') {
  throw '该脚本只能在 Windows 上运行。'
}

$resolvedExecutable = (Resolve-Path -LiteralPath $ExecutablePath).Path
$resolvedOutput = [IO.Path]::GetFullPath($OutputDirectory)
New-Item -ItemType Directory -Path $resolvedOutput -Force | Out-Null

# Establish one physical-coordinate system before loading WinForms or querying
# any HWND. Windows otherwise virtualizes some coordinates for powershell.exe at
# 125%/150% scaling and the test can click or measure the wrong physical pixel.
Add-Type -TypeDefinition @'
using System;
using System.Collections.Generic;
using System.Runtime.InteropServices;

public static class HualiVisualSmokeNative
{
    [StructLayout(LayoutKind.Sequential)]
    public struct RECT
    {
        public int Left;
        public int Top;
        public int Right;
        public int Bottom;
    }

    [StructLayout(LayoutKind.Sequential)]
    public struct MONITORINFO
    {
        public int Size;
        public RECT Monitor;
        public RECT Work;
        public uint Flags;
    }

    private static readonly IntPtr PerMonitorAwareV2 = new IntPtr(-4);

    private delegate bool EnumWindowsProc(IntPtr hWnd, IntPtr lParam);

    [DllImport("user32.dll")]
    private static extern bool EnumWindows(EnumWindowsProc callback, IntPtr lParam);

    [DllImport("user32.dll")]
    private static extern bool IsWindowVisible(IntPtr hWnd);

    [DllImport("user32.dll")]
    private static extern uint GetWindowThreadProcessId(IntPtr hWnd, out uint processId);

    [DllImport("user32.dll")]
    public static extern bool GetWindowRect(IntPtr hWnd, out RECT rect);

    [DllImport("user32.dll")]
    public static extern bool SetCursorPos(int x, int y);

    [DllImport("user32.dll")]
    public static extern uint GetDpiForWindow(IntPtr hWnd);

    [DllImport("user32.dll", SetLastError = true)]
    private static extern bool SetProcessDpiAwarenessContext(IntPtr value);

    [DllImport("user32.dll", SetLastError = true)]
    private static extern IntPtr SetThreadDpiAwarenessContext(IntPtr value);

    [DllImport("user32.dll")]
    private static extern IntPtr GetThreadDpiAwarenessContext();

    [DllImport("user32.dll")]
    private static extern bool AreDpiAwarenessContextsEqual(IntPtr first, IntPtr second);

    [DllImport("user32.dll")]
    public static extern IntPtr MonitorFromWindow(IntPtr hWnd, uint flags);

    [DllImport("user32.dll", CharSet = CharSet.Auto)]
    public static extern bool GetMonitorInfo(IntPtr monitor, ref MONITORINFO info);

    [DllImport("user32.dll")]
    public static extern void mouse_event(uint flags, uint dx, uint dy, uint data, UIntPtr extraInfo);

    [DllImport("user32.dll", SetLastError = true)]
    public static extern bool SetWindowPos(
        IntPtr hWnd,
        IntPtr insertAfter,
        int x,
        int y,
        int width,
        int height,
        uint flags
    );

    public static IntPtr[] VisibleWindowsForProcess(int processId)
    {
        var result = new List<IntPtr>();
        EnumWindows((hWnd, _) =>
        {
            uint owner;
            GetWindowThreadProcessId(hWnd, out owner);
            if (owner == processId && IsWindowVisible(hWnd))
            {
                result.Add(hWnd);
            }
            return true;
        }, IntPtr.Zero);
        return result.ToArray();
    }

    public static bool EnablePerMonitorV2()
    {
        // The process call can legitimately return access denied when the host
        // manifest already selected an awareness mode. The thread override is
        // authoritative for every coordinate operation performed by this test.
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
}
'@

if (-not [HualiVisualSmokeNative]::EnablePerMonitorV2()) {
  throw '无法将 Windows 视觉测试线程设置为 Per-Monitor-V2 DPI 模式。'
}

Add-Type -AssemblyName System.Drawing
Add-Type -AssemblyName System.Windows.Forms

# Keep the visual evidence independent from whatever the interactive runner is
# drawing behind the product. The workflow host is pwsh (normally MTA), so the
# WinForms message loop lives on its own STA thread. This is an ordinary-z-order
# window: the product's always-on-top mascot and menu remain above it, while an
# external click can still take focus from the menu and verify dismissal.
Add-Type -TypeDefinition @'
using System;
using System.ComponentModel;
using System.Drawing;
using System.Runtime.InteropServices;
using System.Threading;
using System.Windows.Forms;

public sealed class HualiVisualSmokeBackdrop
{
    private static readonly IntPtr PerMonitorAwareV2 = new IntPtr(-4);

    private readonly Rectangle bounds;
    private readonly Color color;
    private readonly ManualResetEventSlim ready = new ManualResetEventSlim(false);
    private readonly ManualResetEventSlim stopRequested = new ManualResetEventSlim(false);
    private Thread thread;
    private Form form;
    private Exception failure;

    [DllImport("user32.dll", SetLastError = true)]
    private static extern IntPtr SetThreadDpiAwarenessContext(IntPtr value);

    public HualiVisualSmokeBackdrop(Rectangle bounds, int red, int green, int blue)
    {
        this.bounds = bounds;
        this.color = Color.FromArgb(red, green, blue);
    }

    public void Start()
    {
        if (thread != null)
        {
            throw new InvalidOperationException("The visual-smoke backdrop was already started.");
        }

        thread = new Thread(Run);
        thread.Name = "Huali visual-smoke backdrop";
        thread.IsBackground = true;
        thread.SetApartmentState(ApartmentState.STA);
        thread.Start();

        if (!ready.Wait(TimeSpan.FromSeconds(5)))
        {
            throw new TimeoutException("The visual-smoke backdrop did not become ready in five seconds.");
        }
        ThrowIfFailed();
    }

    public void CloseAndWait()
    {
        Thread currentThread = thread;
        if (currentThread == null)
        {
            return;
        }

        stopRequested.Set();
        Form currentForm = form;
        if (currentForm != null && currentForm.IsHandleCreated && !currentForm.IsDisposed)
        {
            try
            {
                currentForm.BeginInvoke(new Action(currentForm.Close));
            }
            catch (InvalidOperationException)
            {
                // The UI thread may already be finishing. Join below is the
                // authoritative proof that no backdrop HWND remains.
            }
        }

        if (!currentThread.Join(TimeSpan.FromSeconds(5)))
        {
            throw new TimeoutException("The visual-smoke backdrop did not close in five seconds.");
        }
        ThrowIfFailed();
    }

    private void Run()
    {
        try
        {
            if (SetThreadDpiAwarenessContext(PerMonitorAwareV2) == IntPtr.Zero)
            {
                throw new Win32Exception(
                    Marshal.GetLastWin32Error(),
                    "Unable to set the backdrop UI thread to Per-Monitor-V2 DPI awareness."
                );
            }

            using (Form backdrop = new Form())
            {
                form = backdrop;
                backdrop.AutoScaleMode = AutoScaleMode.None;
                backdrop.BackColor = color;
                backdrop.ControlBox = false;
                backdrop.FormBorderStyle = FormBorderStyle.None;
                backdrop.MaximizeBox = false;
                backdrop.MinimizeBox = false;
                backdrop.ShowInTaskbar = false;
                backdrop.StartPosition = FormStartPosition.Manual;
                backdrop.Text = "Huali AI visual-smoke backdrop";
                backdrop.TopMost = false;
                backdrop.Bounds = bounds;
                backdrop.Shown += delegate
                {
                    backdrop.Refresh();
                    backdrop.Update();
                    ready.Set();
                    if (stopRequested.IsSet)
                    {
                        backdrop.BeginInvoke(new Action(backdrop.Close));
                    }
                };
                if (stopRequested.IsSet)
                {
                    ready.Set();
                    return;
                }
                using (System.Windows.Forms.Timer stopTimer = new System.Windows.Forms.Timer())
                {
                    stopTimer.Interval = 50;
                    stopTimer.Tick += delegate
                    {
                        if (stopRequested.IsSet && !backdrop.IsDisposed)
                        {
                            backdrop.Close();
                        }
                    };
                    stopTimer.Start();
                    Application.Run(backdrop);
                }
            }
        }
        catch (Exception exception)
        {
            failure = exception;
            ready.Set();
        }
        finally
        {
            form = null;
        }
    }

    private void ThrowIfFailed()
    {
        if (failure != null)
        {
            throw new InvalidOperationException("The visual-smoke backdrop failed.", failure);
        }
    }
}
'@ -ReferencedAssemblies @(
  [Drawing.Bitmap].Assembly.Location,
  [Windows.Forms.Form].Assembly.Location
)

function Get-WindowSnapshot {
  param([Parameter(Mandatory = $true)][Diagnostics.Process]$Process)

  $windows = foreach ($handle in [HualiVisualSmokeNative]::VisibleWindowsForProcess($Process.Id)) {
    $rect = New-Object HualiVisualSmokeNative+RECT
    if (-not [HualiVisualSmokeNative]::GetWindowRect($handle, [ref]$rect)) {
      continue
    }
    $width = $rect.Right - $rect.Left
    $height = $rect.Bottom - $rect.Top
    if ($width -le 0 -or $height -le 0) {
      continue
    }
    [pscustomobject]@{
      Handle = $handle.ToInt64()
      Left = $rect.Left
      Top = $rect.Top
      Right = $rect.Right
      Bottom = $rect.Bottom
      Width = $width
      Height = $height
      Area = $width * $height
    }
  }
  return @($windows | Sort-Object Area -Descending)
}

function Wait-ForWindows {
  param(
    [Parameter(Mandatory = $true)][Diagnostics.Process]$Process,
    [Parameter(Mandatory = $true)][scriptblock]$Condition,
    [int]$TimeoutSeconds = 20
  )

  $deadline = [DateTime]::UtcNow.AddSeconds($TimeoutSeconds)
  do {
    if ($Process.HasExited) {
      throw "华力 AI 桌面助手提前退出，退出码：$($Process.ExitCode)"
    }
    $windows = @(Get-WindowSnapshot -Process $Process)
    if (& $Condition $windows) {
      return $windows
    }
    Start-Sleep -Milliseconds 100
  } while ([DateTime]::UtcNow -lt $deadline)

  throw "等待 Windows 界面状态超时（$TimeoutSeconds 秒）。"
}

function Find-WindowByHandle {
  param(
    [Parameter(Mandatory = $true)]$Windows,
    [Parameter(Mandatory = $true)][long]$Handle
  )

  return $Windows | Where-Object { [long]$_.Handle -eq $Handle } | Select-Object -First 1
}

function Find-WindowByLogicalSize {
  param(
    [Parameter(Mandatory = $true)]$Windows,
    [Parameter(Mandatory = $true)][double]$LogicalWidth,
    [Parameter(Mandatory = $true)][double]$LogicalHeight,
    [Parameter(Mandatory = $true)][double]$Scale,
    [long[]]$ExcludedHandles = @(),
    [int]$Tolerance = 3
  )

  $expectedWidth = [int][Math]::Round($LogicalWidth * $Scale)
  $expectedHeight = [int][Math]::Round($LogicalHeight * $Scale)
  return $Windows | Where-Object {
    [long]$_.Handle -notin $ExcludedHandles -and
    [Math]::Abs([int]$_.Width - $expectedWidth) -le $Tolerance -and
    [Math]::Abs([int]$_.Height - $expectedHeight) -le $Tolerance
  } | Select-Object -First 1
}

function Find-MascotWindow {
  param([Parameter(Mandatory = $true)]$Windows)

  # At first launch the auth reminder can expand the mascot from 120x104 DIP to
  # as much as 320x480 DIP before the first EnumWindows sample. Match the known
  # mascot size envelope at each HWND's own DPI; the panel and menu are still
  # hidden at this point, and WebView2's visible 13x13 helpers fall far outside.
  $matches = foreach ($window in $Windows) {
    $windowDpi = [HualiVisualSmokeNative]::GetDpiForWindow([IntPtr][long]$window.Handle)
    if ($windowDpi -lt 96) { $windowDpi = 96 }
    $windowScale = $windowDpi / 96.0
    $logicalWidth = $window.Width / $windowScale
    $logicalHeight = $window.Height / $windowScale
    if ($logicalWidth -ge 118 -and $logicalWidth -le 322 -and
        $logicalHeight -ge 102 -and $logicalHeight -le 482) {
      [pscustomobject]@{
        Window = $window
        Area = $window.Area
      }
    }
  }
  return $matches |
    Sort-Object Area -Descending |
    Select-Object -ExpandProperty Window -First 1
}

function Assert-WindowLogicalSize {
  param(
    [Parameter(Mandatory = $true)]$Window,
    [Parameter(Mandatory = $true)][double]$LogicalWidth,
    [Parameter(Mandatory = $true)][double]$LogicalHeight,
    [Parameter(Mandatory = $true)][double]$Scale,
    [Parameter(Mandatory = $true)][string]$Label,
    [int]$Tolerance = 3
  )

  $expectedWidth = [int][Math]::Round($LogicalWidth * $Scale)
  $expectedHeight = [int][Math]::Round($LogicalHeight * $Scale)
  if ([Math]::Abs([int]$Window.Width - $expectedWidth) -gt $Tolerance -or
      [Math]::Abs([int]$Window.Height - $expectedHeight) -gt $Tolerance) {
    throw "$Label 尺寸错误：实际=$($Window.Width)x$($Window.Height)，预期=${expectedWidth}x${expectedHeight}。"
  }
}

function Get-MonitorWorkArea {
  param([Parameter(Mandatory = $true)][long]$WindowHandle)

  $monitor = [HualiVisualSmokeNative]::MonitorFromWindow([IntPtr]$WindowHandle, 2)
  if ($monitor -eq [IntPtr]::Zero) {
    throw '无法确定机器人所在的 Windows 显示器。'
  }
  $info = New-Object HualiVisualSmokeNative+MONITORINFO
  $info.Size = [Runtime.InteropServices.Marshal]::SizeOf($info)
  if (-not [HualiVisualSmokeNative]::GetMonitorInfo($monitor, [ref]$info)) {
    throw '无法读取机器人所在显示器的物理工作区。'
  }
  return [pscustomobject]@{
    Left = $info.Work.Left
    Top = $info.Work.Top
    Right = $info.Work.Right
    Bottom = $info.Work.Bottom
    Width = $info.Work.Right - $info.Work.Left
    Height = $info.Work.Bottom - $info.Work.Top
  }
}

function Save-ScreenCapture {
  param([Parameter(Mandatory = $true)][string]$FileName)

  $screen = [Windows.Forms.SystemInformation]::VirtualScreen
  $bitmap = New-Object Drawing.Bitmap $screen.Width, $screen.Height
  $graphics = [Drawing.Graphics]::FromImage($bitmap)
  try {
    $graphics.CopyFromScreen($screen.Left, $screen.Top, 0, 0, $screen.Size)
    $path = Join-Path $resolvedOutput $FileName
    $bitmap.Save($path, [Drawing.Imaging.ImageFormat]::Png)
    return $path
  } finally {
    $graphics.Dispose()
    $bitmap.Dispose()
  }
}

function Save-RegionCapture {
  param(
    [Parameter(Mandatory = $true)]$Region,
    [Parameter(Mandatory = $true)][string]$FileName
  )

  $virtualScreen = [Windows.Forms.SystemInformation]::VirtualScreen
  if ($Region.Width -le 0 -or $Region.Height -le 0 -or
      $Region.Left -lt $virtualScreen.Left -or
      $Region.Top -lt $virtualScreen.Top -or
      ($Region.Left + $Region.Width) -gt $virtualScreen.Right -or
      ($Region.Top + $Region.Height) -gt $virtualScreen.Bottom) {
    throw "局部截图区域超出 Windows 虚拟屏幕：$($Region.Left),$($Region.Top) $($Region.Width)x$($Region.Height)。"
  }
  $bitmap = New-Object Drawing.Bitmap $Region.Width, $Region.Height
  $graphics = [Drawing.Graphics]::FromImage($bitmap)
  try {
    $graphics.CopyFromScreen($Region.Left, $Region.Top, 0, 0, $bitmap.Size)
    $path = Join-Path $resolvedOutput $FileName
    $parent = Split-Path -Parent $path
    New-Item -ItemType Directory -Path $parent -Force | Out-Null
    $bitmap.Save($path, [Drawing.Imaging.ImageFormat]::Png)
    return $path
  } finally {
    $graphics.Dispose()
    $bitmap.Dispose()
  }
}

function Get-FixedBackdropRegionMetrics {
  param(
    [Parameter(Mandatory = $true)][string]$ImagePath,
    [Parameter(Mandatory = $true)]$Region,
    [Parameter(Mandatory = $true)][int]$ExpectedRed,
    [Parameter(Mandatory = $true)][int]$ExpectedGreen,
    [Parameter(Mandatory = $true)][int]$ExpectedBlue,
    [int]$ChannelTolerance = 3
  )

  $virtualScreen = [Windows.Forms.SystemInformation]::VirtualScreen
  $image = [Drawing.Bitmap]::FromFile($ImagePath)
  try {
    [long]$redTotal = 0
    [long]$greenTotal = 0
    [long]$blueTotal = 0
    [long]$channelDifference = 0
    [long]$matchingPixels = 0
    [long]$sampledPixels = 0
    for ($y = 0; $y -lt $Region.Height; $y++) {
      for ($x = 0; $x -lt $Region.Width; $x++) {
        $pixel = $image.GetPixel(
          $Region.Left - $virtualScreen.Left + $x,
          $Region.Top - $virtualScreen.Top + $y
        )
        $redDifference = [Math]::Abs([int]$pixel.R - $ExpectedRed)
        $greenDifference = [Math]::Abs([int]$pixel.G - $ExpectedGreen)
        $blueDifference = [Math]::Abs([int]$pixel.B - $ExpectedBlue)
        $redTotal += $pixel.R
        $greenTotal += $pixel.G
        $blueTotal += $pixel.B
        $channelDifference += $redDifference + $greenDifference + $blueDifference
        if ($redDifference -le $ChannelTolerance -and
            $greenDifference -le $ChannelTolerance -and
            $blueDifference -le $ChannelTolerance) {
          $matchingPixels++
        }
        $sampledPixels++
      }
    }
    if ($sampledPixels -eq 0) { throw '固定测试背景检查没有采样到像素。' }
    return [ordered]@{
      sampledPixels = $sampledPixels
      matchingPixels = $matchingPixels
      matchingFraction = [Math]::Round($matchingPixels / $sampledPixels, 6)
      meanChannelDifference = [Math]::Round($channelDifference / ($sampledPixels * 3), 3)
      observedMeanRgb = @(
        [Math]::Round($redTotal / $sampledPixels, 2),
        [Math]::Round($greenTotal / $sampledPixels, 2),
        [Math]::Round($blueTotal / $sampledPixels, 2)
      )
    }
  } finally {
    $image.Dispose()
  }
}

function Assert-FixedBackdropRegion {
  param(
    [Parameter(Mandatory = $true)]$Metrics,
    [Parameter(Mandatory = $true)][string]$Stage
  )

  if ($Metrics.matchingFraction -lt 0.99 -or $Metrics.meanChannelDifference -gt 3) {
    throw "$Stage 的固定测试背景未覆盖或尚未稳定：匹配率=$($Metrics.matchingFraction)，通道平均差=$($Metrics.meanChannelDifference)。"
  }
}

function Get-TransparentEdgeMetrics {
  param(
    [Parameter(Mandatory = $true)][string]$FramePath,
    [Parameter(Mandatory = $true)][int]$ExpectedRed,
    [Parameter(Mandatory = $true)][int]$ExpectedGreen,
    [Parameter(Mandatory = $true)][int]$ExpectedBlue,
    [Parameter(Mandatory = $true)][int]$Border,
    [switch]$IncludeTop,
    [int]$ChannelTolerance = 3
  )

  $frame = [Drawing.Bitmap]::FromFile($FramePath)
  try {
    if ($Border -le 0 -or $Border * 2 -ge $frame.Width -or $Border * 2 -ge $frame.Height) {
      throw "透明外缘宽度无效：$Border，截图=$($frame.Width)x$($frame.Height)。"
    }

    [long]$channelDifference = 0
    [long]$matchingPixels = 0
    [long]$nearWhitePixels = 0
    [long]$sampledPixels = 0
    $edgeSamples = [ordered]@{ left = 0; right = 0; bottom = 0; top = 0 }
    $edgeMatches = [ordered]@{ left = 0; right = 0; bottom = 0; top = 0 }

    for ($y = 0; $y -lt $frame.Height; $y++) {
      for ($x = 0; $x -lt $frame.Width; $x++) {
        # When a login/system card is expanded, its legitimate lower border can
        # touch the top of the 120x104 avatar crop. Exclude the complete top
        # strip at this stage (scaled by Border), while retaining both sides and
        # the bottom. A second four-edge check runs after the menu hides cards.
        $onLeft = $x -lt $Border -and ($IncludeTop -or $y -ge $Border)
        $onRight = $x -ge ($frame.Width - $Border) -and ($IncludeTop -or $y -ge $Border)
        $onBottom = $y -ge ($frame.Height - $Border)
        $onTop = $IncludeTop -and $y -lt $Border
        if (-not ($onLeft -or $onRight -or $onBottom -or $onTop)) {
          continue
        }

        $pixel = $frame.GetPixel($x, $y)
        $redDifference = [Math]::Abs([int]$pixel.R - $ExpectedRed)
        $greenDifference = [Math]::Abs([int]$pixel.G - $ExpectedGreen)
        $blueDifference = [Math]::Abs([int]$pixel.B - $ExpectedBlue)
        $matches = $redDifference -le $ChannelTolerance -and
          $greenDifference -le $ChannelTolerance -and
          $blueDifference -le $ChannelTolerance
        $channelDifference += $redDifference + $greenDifference + $blueDifference
        $sampledPixels++
        if ($matches) { $matchingPixels++ }
        if ($pixel.R -ge 245 -and $pixel.G -ge 245 -and $pixel.B -ge 245) {
          $nearWhitePixels++
        }

        if ($onLeft) {
          $edgeSamples['left']++
          if ($matches) { $edgeMatches['left']++ }
        }
        if ($onRight) {
          $edgeSamples['right']++
          if ($matches) { $edgeMatches['right']++ }
        }
        if ($onBottom) {
          $edgeSamples['bottom']++
          if ($matches) { $edgeMatches['bottom']++ }
        }
        if ($onTop) {
          $edgeSamples['top']++
          if ($matches) { $edgeMatches['top']++ }
        }
      }
    }

    if ($sampledPixels -eq 0) { throw '机器人透明外缘检查没有采样到像素。' }
    $edgeMatchingFractions = [ordered]@{}
    foreach ($edgeName in @('left', 'right', 'bottom', 'top')) {
      if ($edgeSamples[$edgeName] -gt 0) {
        $edgeMatchingFractions[$edgeName] = [Math]::Round(
          $edgeMatches[$edgeName] / $edgeSamples[$edgeName],
          6
        )
      }
    }
    return [ordered]@{
      sampledPixels = $sampledPixels
      matchingPixels = $matchingPixels
      matchingFraction = [Math]::Round($matchingPixels / $sampledPixels, 6)
      changedPixelRatio = [Math]::Round(($sampledPixels - $matchingPixels) / $sampledPixels, 6)
      meanChannelDifference = [Math]::Round($channelDifference / ($sampledPixels * 3), 3)
      nearWhitePixels = $nearWhitePixels
      includedTop = [bool]$IncludeTop
      edgeMatchingFractions = $edgeMatchingFractions
    }
  } finally {
    $frame.Dispose()
  }
}

function Assert-TransparentEdgeMetrics {
  param(
    [Parameter(Mandatory = $true)]$Metrics,
    [Parameter(Mandatory = $true)][string]$Stage
  )

  $weakEdges = @(
    $Metrics.edgeMatchingFractions.GetEnumerator() |
      Where-Object { [double]$_.Value -lt 0.95 } |
      ForEach-Object { "$($_.Key)=$($_.Value)" }
  )
  if ($Metrics.matchingFraction -lt 0.98 -or
      $Metrics.meanChannelDifference -gt 3 -or
      $weakEdges.Count -gt 0) {
    throw "$Stage 检测到不透明底色或白框：整体匹配率=$($Metrics.matchingFraction)，通道平均差=$($Metrics.meanChannelDifference)，异常边=$($weakEdges -join ',')。"
  }
}

function Get-MenuVisualMetrics {
  param(
    [Parameter(Mandatory = $true)][string]$BaselinePath,
    [Parameter(Mandatory = $true)][string]$FramePath,
    [Parameter(Mandatory = $true)]$Region,
    [Parameter(Mandatory = $true)][double]$Scale,
    [Parameter(Mandatory = $true)][double]$AnchorX,
    [ValidateSet('Above', 'Below')][string]$Placement
  )

  $virtualScreen = [Windows.Forms.SystemInformation]::VirtualScreen
  $baseline = [Drawing.Bitmap]::FromFile($BaselinePath)
  $frame = [Drawing.Bitmap]::FromFile($FramePath)
  try {
    $perimeter = [Math]::Max(2, [int][Math]::Round(4 * $Scale))
    $coreLeft = [int][Math]::Round(12 * $Scale)
    $coreRight = [Math]::Min($Region.Width, [int][Math]::Round(180 * $Scale))
    $coreTop = if ($Placement -eq 'Above') {
      [int][Math]::Round(8 * $Scale)
    } else {
      [int][Math]::Round(14 * $Scale)
    }
    $coreBottom = [Math]::Min($Region.Height, $coreTop + [int][Math]::Round(42 * $Scale))
    $shadowTop = if ($Placement -eq 'Above') {
      [int][Math]::Round(48 * $Scale)
    } else {
      [int][Math]::Round(6 * $Scale)
    }
    $shadowBottom = if ($Placement -eq 'Above') {
      [Math]::Min($Region.Height, [int][Math]::Round(68 * $Scale))
    } else {
      [Math]::Min($Region.Height, [int][Math]::Round(22 * $Scale))
    }
    $shadowLeft = [int][Math]::Round(8 * $Scale)
    $shadowRight = [Math]::Min($Region.Width, [int][Math]::Round(184 * $Scale))

    [long]$changedPixels = 0
    [long]$perimeterDifference = 0
    [long]$perimeterSamples = 0
    [long]$perimeterChangedPixels = 0
    [long]$whiteSurfacePixels = 0
    [long]$inkPixels = 0
    [long]$redInkPixels = 0
    [long]$coreSamples = 0
    [long]$shadowChangedPixels = 0
    [long]$tailChangedPixels = 0
    $shadowTailExclusion = [Math]::Max(6, [int][Math]::Round(10 * $Scale))
    $tailRadius = [Math]::Max(4, [int][Math]::Round(7 * $Scale))

    for ($y = 0; $y -lt $Region.Height; $y++) {
      for ($x = 0; $x -lt $Region.Width; $x++) {
        $baselinePixel = $baseline.GetPixel(
          $Region.Left - $virtualScreen.Left + $x,
          $Region.Top - $virtualScreen.Top + $y
        )
        $framePixel = $frame.GetPixel($x, $y)
        $difference = [Math]::Abs([int]$baselinePixel.R - [int]$framePixel.R) +
          [Math]::Abs([int]$baselinePixel.G - [int]$framePixel.G) +
          [Math]::Abs([int]$baselinePixel.B - [int]$framePixel.B)
        if ($difference -gt 18) { $changedPixels++ }

        $isPerimeter = $x -lt $perimeter -or $x -ge ($Region.Width - $perimeter) -or
          $y -lt $perimeter -or $y -ge ($Region.Height - $perimeter)
        if ($isPerimeter) {
          $perimeterDifference += $difference
          $perimeterSamples += 3
          if ($difference -gt 18) { $perimeterChangedPixels++ }
        }

        if ($x -ge $coreLeft -and $x -lt $coreRight -and
            $y -ge $coreTop -and $y -lt $coreBottom) {
          $coreSamples++
          if ($framePixel.R -ge 225 -and $framePixel.G -ge 225 -and $framePixel.B -ge 225) {
            $whiteSurfacePixels++
          }
          if ($framePixel.R -le 195 -and $framePixel.G -le 195 -and $framePixel.B -le 195) {
            $inkPixels++
          }
          if ([int]$framePixel.R - [int]$framePixel.G -ge 20 -and
              [int]$framePixel.R - [int]$framePixel.B -ge 10 -and
              $framePixel.R -ge 90 -and $framePixel.R -le 230) {
            $redInkPixels++
          }
        }

        $isShadowBand = $x -ge $shadowLeft -and $x -lt $shadowRight -and
            $y -ge $shadowTop -and $y -lt $shadowBottom -and
            ($y -lt $coreTop -or $y -ge $coreBottom)
        if ($isShadowBand -and $difference -gt 8) {
          if ([Math]::Abs($x - $AnchorX) -le $tailRadius) {
            $tailChangedPixels++
          } elseif ([Math]::Abs($x - $AnchorX) -gt $shadowTailExclusion) {
            # Exclude the white pointer itself: only pixels spread away from
            # the anchor can prove that the card shadow was rendered.
            $shadowChangedPixels++
          }
        }
      }
    }

    if ($perimeterSamples -eq 0 -or $coreSamples -eq 0) {
      throw '菜单视觉检查没有采样到有效像素。'
    }
    $totalPixels = [long]$Region.Width * [long]$Region.Height
    $perimeterMeanDifference = [Math]::Round($perimeterDifference / $perimeterSamples, 3)
    $minimumChangedPixels = [Math]::Max(80, [int][Math]::Round($totalPixels * 0.01))
    $minimumWhitePixels = [Math]::Max(120, [int][Math]::Round($coreSamples * 0.3))
    $minimumInkPixels = [Math]::Max(16, [int][Math]::Round(16 * $Scale * $Scale))
    $minimumRedPixels = [Math]::Max(3, [int][Math]::Round(3 * $Scale * $Scale))
    $minimumShadowPixels = [Math]::Max(8, [int][Math]::Round(8 * $Scale * $Scale))
    $minimumTailPixels = [Math]::Max(3, [int][Math]::Round(3 * $Scale * $Scale))
    $maximumPerimeterChangedPixels = [Math]::Max(8, [int][Math]::Round($perimeterSamples / 3 * 0.08))

    if ($changedPixels -lt $minimumChangedPixels) {
      throw "菜单局部截图几乎为空：变化像素=$changedPixels，最低要求=$minimumChangedPixels。"
    }
    if ($whiteSurfacePixels -lt $minimumWhitePixels -or $inkPixels -lt $minimumInkPixels) {
      throw "菜单卡片或按钮文字未完整渲染：白色表面=$whiteSurfacePixels，文字/图标=$inkPixels。"
    }
    if ($redInkPixels -lt $minimumRedPixels) {
      throw ('菜单“退出”危险操作未检测到红色文字/图标：像素={0}。' -f $redInkPixels)
    }
    if ($shadowChangedPixels -lt $minimumShadowPixels) {
      throw "菜单阴影未渲染到指针以外的安全留白：像素=$shadowChangedPixels。"
    }
    if ($tailChangedPixels -lt $minimumTailPixels) {
      throw "菜单指针未在机器人锚点方向渲染：像素=$tailChangedPixels。"
    }
    if ($perimeterMeanDifference -gt 12 -or
        $perimeterChangedPixels -gt $maximumPerimeterChangedPixels) {
      throw "菜单透明外缘异常，可能出现白底或阴影裁切：均值=$perimeterMeanDifference，变化像素=$perimeterChangedPixels。"
    }

    return [ordered]@{
      changedPixels = $changedPixels
      whiteSurfacePixels = $whiteSurfacePixels
      inkPixels = $inkPixels
      redInkPixels = $redInkPixels
      shadowChangedPixels = $shadowChangedPixels
      tailChangedPixels = $tailChangedPixels
      transparentPerimeterMeanDifference = $perimeterMeanDifference
      transparentPerimeterChangedPixels = $perimeterChangedPixels
    }
  } finally {
    $baseline.Dispose()
    $frame.Dispose()
  }
}

function Invoke-MouseClick {
  param(
    [Parameter(Mandatory = $true)][int]$X,
    [Parameter(Mandatory = $true)][int]$Y,
    [ValidateSet('Left', 'Right')][string]$Button = 'Left'
  )

  if (-not [HualiVisualSmokeNative]::SetCursorPos($X, $Y)) {
    throw "无法将鼠标移到 $X,$Y。"
  }
  Start-Sleep -Milliseconds 80
  if ($Button -eq 'Right') {
    [HualiVisualSmokeNative]::mouse_event(0x0008, 0, 0, 0, [UIntPtr]::Zero)
    [HualiVisualSmokeNative]::mouse_event(0x0010, 0, 0, 0, [UIntPtr]::Zero)
  } else {
    [HualiVisualSmokeNative]::mouse_event(0x0002, 0, 0, 0, [UIntPtr]::Zero)
    [HualiVisualSmokeNative]::mouse_event(0x0004, 0, 0, 0, [UIntPtr]::Zero)
  }
}

function Assert-RectUnchanged {
  param(
    [Parameter(Mandatory = $true)]$Before,
    [Parameter(Mandatory = $true)]$After,
    [Parameter(Mandatory = $true)][string]$Stage
  )

  foreach ($property in @('Left', 'Top', 'Width', 'Height')) {
    $delta = [Math]::Abs([int]$Before.$property - [int]$After.$property)
    if ($delta -gt 1) {
      throw "$Stage 时机器人窗口 $property 发生了 $delta 像素跳动。"
    }
  }
}

function Get-AvatarClickPoint {
  param(
    [Parameter(Mandatory = $true)]$MascotWindow,
    [Parameter(Mandatory = $true)][double]$Scale
  )

  return [pscustomobject]@{
    X = [int](($MascotWindow.Left + $MascotWindow.Right) / 2)
    # The avatar is bottom-aligned with an 8-DIP safety floor. Its 88-DIP
    # center is therefore 52 DIP above the native window bottom.
    Y = [int]($MascotWindow.Bottom - [Math]::Round(52 * $Scale))
  }
}

function Remove-VisualSmokeDataDirectory {
  param([Parameter(Mandatory = $true)][string]$Path)

  # WebView2 browser processes can outlive their host HWND briefly. Retry only
  # this child PID's dedicated temp directory; never terminate shared WebView2
  # processes or delete the product's normal user-data directory.
  for ($attempt = 1; $attempt -le 40; $attempt++) {
    if (-not (Test-Path -LiteralPath $Path)) {
      return
    }
    try {
      Remove-Item -LiteralPath $Path -Recurse -Force -ErrorAction Stop
      return
    } catch {
      if ($attempt -eq 40) {
        throw
      }
      Start-Sleep -Milliseconds 250
    }
  }
}

$report = [ordered]@{
  executable = $resolvedExecutable
  startedAt = [DateTime]::UtcNow.ToString('o')
  dpiAwareness = 'PerMonitorAwareV2'
  # Hosted Windows Server images commonly disable client-area animations,
  # which correctly maps WebView2 to prefers-reduced-motion. The visual gate
  # asks this child to use Tauri/WebView2's programmatic, isolated test options
  # so sprite progression is exercised without changing the user's system-wide
  # accessibility preference. The child accepts only the exact value "1" and
  # maps it to fixed browser arguments; no arbitrary arguments cross this API.
  motionValidation = [ordered]@{
    mode = 'programmatic-webview2-options'
    requested = $false
    isolatedDataDirectoryConfigured = $false
    isolatedDataDirectoryRemoved = $false
    animationProgressionObserved = $false
  }
  backdrop = [ordered]@{
    expectedRgb = @(92, 107, 122)
    shown = $false
    backgroundVerified = $false
    baselineMetrics = $null
    disposed = $false
  }
  ok = $false
  failure = $null
  checks = [ordered]@{}
}
$process = $null
$backdrop = $null
$visualSmokeDataDirectory = $null
$visualFailure = $null
$cleanupFailure = $null

try {
  $virtualScreen = [Windows.Forms.SystemInformation]::VirtualScreen
  [HualiVisualSmokeNative]::SetCursorPos($virtualScreen.Left + 8, $virtualScreen.Top + 8) | Out-Null
  $backdrop = [HualiVisualSmokeBackdrop]::new(
    $virtualScreen,
    [int]$report.backdrop.expectedRgb[0],
    [int]$report.backdrop.expectedRgb[1],
    [int]$report.backdrop.expectedRgb[2]
  )
  $backdrop.Start()
  $report.backdrop.shown = $true
  Start-Sleep -Milliseconds 200
  $baselinePath = Save-ScreenCapture -FileName '00-background-baseline.png'
  $backdropProbeSize = 32
  $primaryScreenBounds = [Windows.Forms.Screen]::PrimaryScreen.Bounds
  $backdropProbe = [pscustomobject]@{
    Left = $primaryScreenBounds.Left + [int](($primaryScreenBounds.Width - $backdropProbeSize) / 2)
    Top = $primaryScreenBounds.Top + [int](($primaryScreenBounds.Height - $backdropProbeSize) / 2)
    Width = $backdropProbeSize
    Height = $backdropProbeSize
  }
  $backdropBaselineMetrics = Get-FixedBackdropRegionMetrics `
    -ImagePath $baselinePath `
    -Region $backdropProbe `
    -ExpectedRed $report.backdrop.expectedRgb[0] `
    -ExpectedGreen $report.backdrop.expectedRgb[1] `
    -ExpectedBlue $report.backdrop.expectedRgb[2]
  $report.backdrop.baselineMetrics = $backdropBaselineMetrics
  Assert-FixedBackdropRegion -Metrics $backdropBaselineMetrics -Stage '视觉验收基线'
  $report.backdrop.backgroundVerified = $true
  $previousVisualSmokeMotion = [Environment]::GetEnvironmentVariable(
    'HUALI_AI_VISUAL_SMOKE_FORCE_MOTION',
    [EnvironmentVariableTarget]::Process
  )
  [Environment]::SetEnvironmentVariable(
    'HUALI_AI_VISUAL_SMOKE_FORCE_MOTION',
    '1',
    [EnvironmentVariableTarget]::Process
  )
  try {
    $process = Start-Process -FilePath $resolvedExecutable -PassThru
    $visualSmokeDataDirectory = Join-Path `
      ([IO.Path]::GetTempPath()) `
      "huali-ai-visual-smoke-$($process.Id)"
    $report.motionValidation.requested = $true
  } finally {
    [Environment]::SetEnvironmentVariable(
      'HUALI_AI_VISUAL_SMOKE_FORCE_MOTION',
      $previousVisualSmokeMotion,
      [EnvironmentVariableTarget]::Process
    )
  }
  $startupWindows = Wait-ForWindows -Process $process -Condition {
    param($windows)
    $null -ne (Find-MascotWindow -Windows $windows)
  }
  if (-not (Test-Path -LiteralPath $visualSmokeDataDirectory -PathType Container)) {
    throw "WebView2 未使用独立的视觉验收数据目录：$visualSmokeDataDirectory"
  }
  $report.motionValidation.isolatedDataDirectoryConfigured = $true
  $mascotBefore = Find-MascotWindow -Windows $startupWindows
  $mascotHandle = [long]$mascotBefore.Handle
  # Every other visible startup HWND is a WebView2/helper surface. The menu is
  # a separate hidden Tauri window at startup, so excluding all of these fixed
  # handles prevents a helper from ever being promoted to the menu identity.
  $menuExcludedHandles = @($mascotHandle) + @(
    $startupWindows |
      Where-Object { [long]$_.Handle -ne $mascotHandle } |
      ForEach-Object { [long]$_.Handle }
  )
  Start-Sleep -Milliseconds 800
  $mascotBefore = Find-WindowByHandle `
    -Windows @(Get-WindowSnapshot -Process $process) `
    -Handle $mascotHandle
  if (-not $mascotBefore) {
    throw '启动后固定的机器人 HWND 已消失。'
  }

  $dpi = [HualiVisualSmokeNative]::GetDpiForWindow([IntPtr]$mascotHandle)
  if ($dpi -lt 96) { $dpi = 96 }
  $scale = $dpi / 96.0
  $mascotLogicalWidth = [Math]::Round($mascotBefore.Width / $scale, 2)
  $mascotLogicalHeight = [Math]::Round($mascotBefore.Height / $scale, 2)
  if ($mascotLogicalWidth -lt 118 -or $mascotLogicalWidth -gt 322 -or
      $mascotLogicalHeight -lt 102 -or $mascotLogicalHeight -gt 482) {
    throw "启动机器人尺寸超出生产布局范围：${mascotLogicalWidth}x${mascotLogicalHeight} DIP。"
  }
  $report.checks.startup = [ordered]@{
    mascot = $mascotBefore
    mascotDpi = $dpi
    mascotScale = $scale
    mascotLogicalWidth = $mascotLogicalWidth
    mascotLogicalHeight = $mascotLogicalHeight
    helperHandlesExcluded = $menuExcludedHandles.Count - 1
  }
  Save-ScreenCapture -FileName '01-startup-login-card.png' | Out-Null
  $animationRegionWidth = [int][Math]::Round(120 * $scale)
  $animationRegionHeight = [int][Math]::Round(104 * $scale)
  $animationRegion = [pscustomobject]@{
    Left = [int](($mascotBefore.Left + $mascotBefore.Right - $animationRegionWidth) / 2)
    Top = [int]($mascotBefore.Bottom - $animationRegionHeight)
    Width = $animationRegionWidth
    Height = $animationRegionHeight
  }
  $animationBaselineMetrics = Get-FixedBackdropRegionMetrics `
    -ImagePath $baselinePath `
    -Region $animationRegion `
    -ExpectedRed $report.backdrop.expectedRgb[0] `
    -ExpectedGreen $report.backdrop.expectedRgb[1] `
    -ExpectedBlue $report.backdrop.expectedRgb[2]
  $report.backdrop.animationRegionMetrics = $animationBaselineMetrics
  Assert-FixedBackdropRegion `
    -Metrics $animationBaselineMetrics `
    -Stage '机器人所在区域的视觉验收基线'
  $animationHashes = @()
  $edgeBorder = [Math]::Max(2, [int][Math]::Round(4 * $scale))
  $animationTransparencyFrames = @()
  $animationCheck = [ordered]@{
    samples = 0
    uniqueFrames = 0
    dpi = $dpi
    transparencyFrames = $animationTransparencyFrames
    minimumMatchingFraction = $null
    maximumMeanChannelDifference = $null
  }
  $report.checks.animation = $animationCheck
  for ($frameIndex = 1; $frameIndex -le 29; $frameIndex++) {
    $framePath = Save-RegionCapture `
      -Region $animationRegion `
      -FileName ('animation\idle-{0:d2}.png' -f $frameIndex)
    $animationHashes += (Get-FileHash -LiteralPath $framePath -Algorithm SHA256).Hash
    $frameTransparency = Get-TransparentEdgeMetrics `
      -FramePath $framePath `
      -ExpectedRed $report.backdrop.expectedRgb[0] `
      -ExpectedGreen $report.backdrop.expectedRgb[1] `
      -ExpectedBlue $report.backdrop.expectedRgb[2] `
      -Border $edgeBorder
    $animationTransparencyFrames += [ordered]@{
      frame = $frameIndex
      metrics = $frameTransparency
    }
    $animationCheck['transparencyFrames'] = $animationTransparencyFrames
    $animationCheck['samples'] = $animationHashes.Count
    # Assert every captured frame so a one-frame WebView2/DWM white flash can
    # never be hidden by an average, percentile or later clean frame.
    Assert-TransparentEdgeMetrics `
      -Metrics $frameTransparency `
      -Stage "机器人空闲动画第 $frameIndex 帧三边透明外缘"
    Start-Sleep -Milliseconds 100
  }
  $uniqueAnimationFrames = @($animationHashes | Select-Object -Unique).Count
  $animationCheck['uniqueFrames'] = $uniqueAnimationFrames
  $animationCheck['minimumMatchingFraction'] = (
    $animationTransparencyFrames |
      ForEach-Object { $_.metrics.matchingFraction } |
      Measure-Object -Minimum
  ).Minimum
  $animationCheck['maximumMeanChannelDifference'] = (
    $animationTransparencyFrames |
      ForEach-Object { $_.metrics.meanChannelDifference } |
      Measure-Object -Maximum
  ).Maximum
  if ($uniqueAnimationFrames -lt 3) {
    throw "Windows WebView2 动画未正常前进：29 次采样仅 $uniqueAnimationFrames 个不同画面。"
  }
  $report.motionValidation.animationProgressionObserved = $true

  $avatarPoint = Get-AvatarClickPoint -MascotWindow $mascotBefore -Scale $scale
  Invoke-MouseClick -X $avatarPoint.X -Y $avatarPoint.Y -Button Right
  $menuOpenWindows = Wait-ForWindows -Process $process -Condition {
    param($windows)
    $null -ne (Find-WindowByLogicalSize `
        -Windows $windows `
        -LogicalWidth 192 `
        -LogicalHeight 76 `
        -Scale $scale `
        -ExcludedHandles $menuExcludedHandles)
  }
  $mascotWithMenu = Find-WindowByHandle -Windows $menuOpenWindows -Handle $mascotHandle
  $menuAbove = Find-WindowByLogicalSize `
    -Windows $menuOpenWindows `
    -LogicalWidth 192 `
    -LogicalHeight 76 `
    -Scale $scale `
    -ExcludedHandles $menuExcludedHandles
  if (-not $mascotWithMenu -or -not $menuAbove) {
    throw '右键后未找到固定机器人 HWND 或独立菜单 HWND。'
  }
  $menuHandle = [long]$menuAbove.Handle
  Start-Sleep -Milliseconds 350
  $paintedWindows = @(Get-WindowSnapshot -Process $process)
  $mascotWithMenu = Find-WindowByHandle -Windows $paintedWindows -Handle $mascotHandle
  $menuAbove = Find-WindowByHandle -Windows $paintedWindows -Handle $menuHandle
  if (-not $mascotWithMenu -or -not $menuAbove) {
    throw '菜单入场动画完成前固定 HWND 意外消失。'
  }
  $menuDpi = [HualiVisualSmokeNative]::GetDpiForWindow([IntPtr]$menuHandle)
  if ($menuDpi -lt 96) { $menuDpi = 96 }
  $menuScale = $menuDpi / 96.0
  Assert-WindowLogicalSize `
    -Window $menuAbove `
    -LogicalWidth 192 `
    -LogicalHeight 76 `
    -Scale $menuScale `
    -Label '上方右键菜单'
  Assert-RectUnchanged -Before $mascotBefore -After $mascotWithMenu -Stage '右键打开菜单'
  $menuAvatarRegion = [pscustomobject]@{
    Left = [int](($mascotWithMenu.Left + $mascotWithMenu.Right - $animationRegionWidth) / 2)
    Top = [int]($mascotWithMenu.Bottom - $animationRegionHeight)
    Width = $animationRegionWidth
    Height = $animationRegionHeight
  }
  $menuAvatarTransparencyPath = Save-RegionCapture `
    -Region $menuAvatarRegion `
    -FileName 'animation\transparency-menu-open-four-edges.png'
  $menuAvatarTransparency = Get-TransparentEdgeMetrics `
    -FramePath $menuAvatarTransparencyPath `
    -ExpectedRed $report.backdrop.expectedRgb[0] `
    -ExpectedGreen $report.backdrop.expectedRgb[1] `
    -ExpectedBlue $report.backdrop.expectedRgb[2] `
    -Border $edgeBorder `
    -IncludeTop
  $report.checks.transparencyMenuOpen = $menuAvatarTransparency
  Assert-TransparentEdgeMetrics `
    -Metrics $menuAvatarTransparency `
    -Stage '菜单打开且提示卡隐藏后的机器人四边透明外缘'
  $avatarTop = $mascotWithMenu.Bottom - [int][Math]::Round(96 * $scale)
  $menuAboveVisibleBottom = $menuAbove.Top + [int][Math]::Round(55 * $menuScale)
  $expectedAboveVisibleBottom = $avatarTop - [int][Math]::Round(18 * $menuScale)
  if ([Math]::Abs($menuAboveVisibleBottom - $expectedAboveVisibleBottom) -gt 2) {
    throw "机器人处于常规位置时，右键菜单可见尾端间距错误：实际=$menuAboveVisibleBottom，预期=$expectedAboveVisibleBottom。"
  }
  $menuAboveBackdropMetrics = Get-FixedBackdropRegionMetrics `
    -ImagePath $baselinePath `
    -Region $menuAbove `
    -ExpectedRed $report.backdrop.expectedRgb[0] `
    -ExpectedGreen $report.backdrop.expectedRgb[1] `
    -ExpectedBlue $report.backdrop.expectedRgb[2]
  Assert-FixedBackdropRegion `
    -Metrics $menuAboveBackdropMetrics `
    -Stage '上方菜单所在区域的视觉验收基线'
  $menuAboveCapture = Save-RegionCapture `
    -Region $menuAbove `
    -FileName '02-context-menu-above-window.png'
  $menuAboveVisual = Get-MenuVisualMetrics `
    -BaselinePath $baselinePath `
    -FramePath $menuAboveCapture `
    -Region $menuAbove `
    -Scale $menuScale `
    -AnchorX ((($mascotWithMenu.Left + $mascotWithMenu.Right) / 2) - $menuAbove.Left) `
    -Placement Above
  $report.checks.menuAbove = [ordered]@{
    mascot = $mascotWithMenu
    menu = $menuAbove
    positionStable = $true
    backdropMetrics = $menuAboveBackdropMetrics
    visual = $menuAboveVisual
  }
  Save-ScreenCapture -FileName '03-context-menu-above-full-screen.png' | Out-Null

  $dismissWorkArea = Get-MonitorWorkArea -WindowHandle $mascotHandle
  Invoke-MouseClick `
    -X ($dismissWorkArea.Left + 12) `
    -Y ($dismissWorkArea.Top + 12)
  $menuClosedWindows = Wait-ForWindows -Process $process -Condition {
    param($windows)
    $null -eq (Find-WindowByHandle -Windows $windows -Handle $menuHandle)
  }
  $mascotAfterClose = Find-WindowByHandle -Windows $menuClosedWindows -Handle $mascotHandle
  if (-not $mascotAfterClose) {
    throw '点击外部关闭菜单后，固定机器人 HWND 意外消失。'
  }
  Assert-RectUnchanged -Before $mascotBefore -After $mascotAfterClose -Stage '点击外部关闭菜单'
  $report.checks.externalDismiss = [ordered]@{
    mascot = $mascotAfterClose
    menuClosed = $true
    positionStable = $true
  }
  Save-ScreenCapture -FileName '04-context-menu-dismissed.png' | Out-Null

  # Place the expanded mascot window partly above the work area so its visible
  # avatar sits near the top edge. The context menu must flip below the avatar.
  # Keep the boundary test on the mascot's current monitor. VirtualScreen.Left
  # may refer to a different-DPI secondary display in a mixed-monitor setup.
  $workArea = Get-MonitorWorkArea -WindowHandle $mascotHandle
  $targetX = $workArea.Left + [int][Math]::Round(120 * $scale)
  $targetTop = $workArea.Top
  $topEdgeY = $targetTop - $mascotAfterClose.Height + [int][Math]::Round(112 * $scale)
  $moved = [HualiVisualSmokeNative]::SetWindowPos(
    [IntPtr]$mascotHandle,
    [IntPtr]::Zero,
    $targetX,
    $topEdgeY,
    $mascotAfterClose.Width,
    $mascotAfterClose.Height,
    0x0014
  )
  if (-not $moved) {
    throw '无法将机器人移到顶部边界测试位置。'
  }
  Start-Sleep -Milliseconds 350
  $topEdgeMascot = Find-WindowByHandle `
    -Windows @(Get-WindowSnapshot -Process $process) `
    -Handle $mascotHandle
  if (-not $topEdgeMascot) {
    throw '移动到顶部边界后固定机器人 HWND 意外消失。'
  }
  $topDpi = [HualiVisualSmokeNative]::GetDpiForWindow([IntPtr]$mascotHandle)
  if ($topDpi -lt 96) { $topDpi = 96 }
  $topScale = $topDpi / 96.0
  $topAvatarPoint = Get-AvatarClickPoint -MascotWindow $topEdgeMascot -Scale $topScale
  Invoke-MouseClick -X $topAvatarPoint.X -Y $topAvatarPoint.Y -Button Right
  $belowWindows = Wait-ForWindows -Process $process -Condition {
    param($windows)
    $null -ne (Find-WindowByHandle -Windows $windows -Handle $menuHandle)
  }
  Start-Sleep -Milliseconds 350
  $belowPaintedWindows = @(Get-WindowSnapshot -Process $process)
  $topMascotWithMenu = Find-WindowByHandle -Windows $belowPaintedWindows -Handle $mascotHandle
  $menuBelow = Find-WindowByHandle -Windows $belowPaintedWindows -Handle $menuHandle
  if (-not $topMascotWithMenu -or -not $menuBelow) {
    throw '下方菜单入场动画完成前固定 HWND 意外消失。'
  }
  $belowMenuDpi = [HualiVisualSmokeNative]::GetDpiForWindow([IntPtr]$menuHandle)
  if ($belowMenuDpi -lt 96) { $belowMenuDpi = 96 }
  $belowMenuScale = $belowMenuDpi / 96.0
  Assert-WindowLogicalSize `
    -Window $menuBelow `
    -LogicalWidth 192 `
    -LogicalHeight 76 `
    -Scale $belowMenuScale `
    -Label '下方右键菜单'
  Assert-RectUnchanged -Before $topEdgeMascot -After $topMascotWithMenu -Stage '顶部边界右键'
  $topAvatarBottom = $topMascotWithMenu.Bottom - [int][Math]::Round(8 * $topScale)
  $menuBelowVisibleTop = $menuBelow.Top + [int][Math]::Round(9 * $belowMenuScale)
  $expectedBelowVisibleTop = $topAvatarBottom + [int][Math]::Round(18 * $belowMenuScale)
  if ([Math]::Abs($menuBelowVisibleTop - $expectedBelowVisibleTop) -gt 2) {
    throw "机器人靠近屏幕顶部时，右键菜单下翻间距错误：实际=$menuBelowVisibleTop，预期=$expectedBelowVisibleTop。"
  }
  $menuBelowBackdropMetrics = Get-FixedBackdropRegionMetrics `
    -ImagePath $baselinePath `
    -Region $menuBelow `
    -ExpectedRed $report.backdrop.expectedRgb[0] `
    -ExpectedGreen $report.backdrop.expectedRgb[1] `
    -ExpectedBlue $report.backdrop.expectedRgb[2]
  Assert-FixedBackdropRegion `
    -Metrics $menuBelowBackdropMetrics `
    -Stage '下方菜单所在区域的视觉验收基线'
  $menuBelowCapture = Save-RegionCapture `
    -Region $menuBelow `
    -FileName '05-context-menu-below-window.png'
  $menuBelowVisual = Get-MenuVisualMetrics `
    -BaselinePath $baselinePath `
    -FramePath $menuBelowCapture `
    -Region $menuBelow `
    -Scale $belowMenuScale `
    -AnchorX ((($topMascotWithMenu.Left + $topMascotWithMenu.Right) / 2) - $menuBelow.Left) `
    -Placement Below
  $report.checks.menuBelow = [ordered]@{
    mascot = $topMascotWithMenu
    menu = $menuBelow
    flippedBelow = $true
    positionStable = $true
    backdropMetrics = $menuBelowBackdropMetrics
    visual = $menuBelowVisual
  }
  Save-ScreenCapture -FileName '06-context-menu-below-top-edge-full-screen.png' | Out-Null

  $report.ok = $true
  $report.completedAt = [DateTime]::UtcNow.ToString('o')
} catch {
  $visualFailure = $_
  $report.failure = $visualFailure.Exception.Message
  try {
    Save-ScreenCapture -FileName '99-failure-full-screen.png' | Out-Null
  } catch {
    # The primary assertion remains authoritative if screen capture itself is
    # unavailable (for example after an interactive desktop disconnect).
  }
} finally {
  try {
    if ($process -and -not $process.HasExited) {
      Stop-Process -Id $process.Id -Force -ErrorAction Stop
      if (-not $process.WaitForExit(5000)) {
        throw "视觉验收结束后，机器人进程 $($process.Id) 未在 5 秒内退出。"
      }
      $process.Refresh()
      if (-not $process.HasExited) {
        throw "视觉验收结束后，机器人进程 $($process.Id) 仍在运行。"
      }
    }
  } catch {
    $cleanupFailure = $_
    $report.ok = $false
    if (-not $report.failure) {
      $report.failure = $_.Exception.Message
    }
  }
  if ($backdrop) {
    try {
      $backdrop.CloseAndWait()
      $report.backdrop.disposed = $true
    } catch {
      if (-not $cleanupFailure) {
        $cleanupFailure = $_
      }
      $report.ok = $false
      if (-not $report.failure) {
        $report.failure = $_.Exception.Message
      }
    }
  }
  if ($visualSmokeDataDirectory) {
    try {
      Remove-VisualSmokeDataDirectory -Path $visualSmokeDataDirectory
      $report.motionValidation.isolatedDataDirectoryRemoved = $true
    } catch {
      if (-not $cleanupFailure) {
        $cleanupFailure = $_
      }
      $report.ok = $false
      if (-not $report.failure) {
        $report.failure = $_.Exception.Message
      }
    }
  }
  $report.completedAt = [DateTime]::UtcNow.ToString('o')
  $reportPath = Join-Path $resolvedOutput 'visual-smoke-report.json'
  $report | ConvertTo-Json -Depth 8 | Set-Content -LiteralPath $reportPath -Encoding UTF8
}

if ($visualFailure) {
  throw $visualFailure
}
if ($cleanupFailure) {
  throw $cleanupFailure
}

Write-Host "Windows 真实窗口视觉冒烟测试通过：$resolvedOutput"
