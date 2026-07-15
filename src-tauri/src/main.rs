#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use std::fs;
#[cfg(windows)]
use std::os::windows::process::CommandExt;
use std::path::PathBuf;
#[cfg(any(target_os = "macos", windows))]
use std::process::Command;
use std::sync::{
    atomic::{AtomicU64, Ordering},
    Arc, Mutex,
};
use std::thread;
use std::time::Duration;
use tauri::menu::{Menu, MenuItem};
use tauri::tray::TrayIconBuilder;
use tauri::window::Color;
use tauri::{Emitter, LogicalPosition, LogicalSize, Manager, Position, Size};

// Keep a transparent safety gutter around the sprite. WebView2 can otherwise
// clip the last physical pixel at 125%/150% Windows display scaling.
const MASCOT_WIDTH: f64 = 168.0;
const MASCOT_HEIGHT: f64 = 144.0;
const MASCOT_PEEK_VISIBLE_WIDTH: f64 = 104.0;
const MASCOT_PEEK_ANIMATION_STEPS: u64 = 32;
const MASCOT_REVEAL_ANIMATION_STEPS: u64 = 24;
const MASCOT_DOCK_ANIMATION_FRAME_MS: u64 = 16;
const DESKTOP_AUTH_CALLBACK_PREFIX: &str = "huali-ai-mascot://auth-callback";
const DESKTOP_AUTH_CALLBACK_FILE: &str = "huali-ai-mascot-auth-callback.tmp";

#[derive(Clone, Default)]
struct PendingDesktopAuthCallback(Arc<Mutex<Option<NativeDesktopAuthCallback>>>);

#[derive(Clone, Default)]
struct MascotDockMotion(Arc<AtomicU64>);

impl MascotDockMotion {
    fn cancel(&self) -> u64 {
        self.0.fetch_add(1, Ordering::SeqCst) + 1
    }
}

#[derive(Clone, Default)]
struct MascotDragMonitor(Arc<AtomicU64>);

impl MascotDragMonitor {
    fn start(&self) -> u64 {
        self.0.fetch_add(1, Ordering::SeqCst) + 1
    }
}

fn async_key_state_is_pressed(state: i16) -> bool {
    state as u16 & 0x8000 != 0
}

#[cfg(windows)]
fn monitor_native_drag_end(app: tauri::AppHandle, monitor: MascotDragMonitor, token: u64) {
    use windows_sys::Win32::UI::Input::KeyboardAndMouse::{GetAsyncKeyState, VK_LBUTTON};

    thread::spawn(move || loop {
        if monitor.0.load(Ordering::SeqCst) != token {
            return;
        }

        let button_state = unsafe { GetAsyncKeyState(VK_LBUTTON as i32) };
        if !async_key_state_is_pressed(button_state) {
            let _ = app.emit_to("mascot", "mascot-native-drag-ended", ());
            return;
        }

        thread::sleep(Duration::from_millis(8));
    });
}

#[derive(Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
struct NativeDesktopAuthCallback {
    callback_url: Option<String>,
    argument_count: usize,
}

fn find_desktop_auth_callback(args: &[String]) -> Option<String> {
    args.iter()
        .find(|arg| arg.starts_with(DESKTOP_AUTH_CALLBACK_PREFIX))
        .cloned()
}

fn desktop_auth_callback_file() -> PathBuf {
    std::env::temp_dir().join(DESKTOP_AUTH_CALLBACK_FILE)
}

fn persist_startup_desktop_auth_callback(callback_url: &str) {
    let _ = fs::write(desktop_auth_callback_file(), callback_url.as_bytes());
}

fn take_persisted_desktop_auth_callback() -> Option<NativeDesktopAuthCallback> {
    let path = desktop_auth_callback_file();
    let callback_url = fs::read_to_string(&path).ok();
    let _ = fs::remove_file(path);

    callback_url.map(|callback_url| NativeDesktopAuthCallback {
        callback_url: Some(callback_url),
        argument_count: 2,
    })
}

impl PendingDesktopAuthCallback {
    fn capture(&self, args: &[String]) -> Option<String> {
        let callback_url = find_desktop_auth_callback(args);
        if let Ok(mut pending) = self.0.lock() {
            pending.replace(NativeDesktopAuthCallback {
                callback_url: callback_url.clone(),
                argument_count: args.len(),
            });
        }
        callback_url
    }

    fn take(&self) -> Option<NativeDesktopAuthCallback> {
        self.0.lock().ok()?.take()
    }
}

#[tauri::command]
fn take_desktop_auth_callback(
    state: tauri::State<'_, PendingDesktopAuthCallback>,
) -> Option<NativeDesktopAuthCallback> {
    state.take().or_else(take_persisted_desktop_auth_callback)
}
const MASCOT_NOTIFICATION_WIDTH: f64 = 320.0;
const MASCOT_NOTIFICATION_HEIGHT: f64 = 456.0;
const MASCOT_MESSAGE_WIDTH: f64 = 220.0;
const MASCOT_MESSAGE_HEIGHT: f64 = 176.0;
const PANEL_WIDTH: f64 = 380.0;
const PANEL_COMPACT_HEIGHT: f64 = 78.0;
const PANEL_EXPANDED_HEIGHT: f64 = 78.0;
const SCREEN_MARGIN: f64 = 24.0;
const MASCOT_REST_RIGHT_MARGIN: f64 = 30.0;
const MASCOT_REST_BOTTOM_MARGIN: f64 = 38.0;
const PANEL_GAP: f64 = 8.0;
const TRANSPARENT: Option<Color> = Some(Color(0, 0, 0, 0));

fn harden_transparent_window(window: &tauri::WebviewWindow) {
    let _ = window.set_shadow(false);
    let _ = window.set_background_color(TRANSPARENT);
}

fn mascot_logical_size(mascot: &tauri::WebviewWindow) -> (f64, f64) {
    let scale = mascot.scale_factor().unwrap_or(1.0);
    mascot
        .outer_size()
        .ok()
        .map(|size| {
            let logical = size.to_logical::<f64>(scale);
            (logical.width, logical.height)
        })
        .unwrap_or((MASCOT_WIDTH, MASCOT_HEIGHT))
}

fn sync_panel_if_visible(app: &tauri::AppHandle) {
    if let (Some(panel), Some(mascot)) = (
        app.get_webview_window("panel"),
        app.get_webview_window("mascot"),
    ) {
        if matches!(panel.is_visible(), Ok(true)) {
            place_panel_near_mascot(&panel, &mascot, false);
        }
    }
}

fn place_bottom_right(window: &tauri::WebviewWindow, width: f64, height: f64) {
    let _ = window.set_size(Size::Logical(LogicalSize { width, height }));

    if let Ok(Some(monitor)) = window.current_monitor() {
        let scale = monitor.scale_factor();
        let screen_size = monitor.work_area().size.to_logical::<f64>(scale);
        let screen_pos = monitor.work_area().position.to_logical::<f64>(scale);
        let x = screen_pos.x + screen_size.width - width - SCREEN_MARGIN;
        let y = screen_pos.y + screen_size.height - height - SCREEN_MARGIN;
        let _ = window.set_position(Position::Logical(LogicalPosition { x, y }));
    }
}

fn place_mascot_bottom_right(window: &tauri::WebviewWindow) {
    let _ = window.set_size(Size::Logical(LogicalSize {
        width: MASCOT_WIDTH,
        height: MASCOT_HEIGHT,
    }));

    if let Ok(Some(monitor)) = window.current_monitor() {
        let scale = monitor.scale_factor();
        let work_size = monitor.work_area().size.to_logical::<f64>(scale);
        let work_pos = monitor.work_area().position.to_logical::<f64>(scale);
        let x = work_pos.x + work_size.width - MASCOT_WIDTH - MASCOT_REST_RIGHT_MARGIN;
        let y = work_pos.y + work_size.height - MASCOT_HEIGHT - MASCOT_REST_BOTTOM_MARGIN;
        let _ = window.set_position(Position::Logical(LogicalPosition { x, y }));
    }
}

fn mascot_dock_target(
    window: &tauri::WebviewWindow,
    width: f64,
    height: f64,
    peek: bool,
) -> Option<LogicalPosition<f64>> {
    let monitor = window.current_monitor().ok().flatten()?;
    let scale = monitor.scale_factor();
    let work_size = monitor.work_area().size.to_logical::<f64>(scale);
    let work_pos = monitor.work_area().position.to_logical::<f64>(scale);
    let current_y = window
        .outer_position()
        .ok()
        .map(|position| position.to_logical::<f64>(scale).y)
        .unwrap_or(work_pos.y + work_size.height - height - SCREEN_MARGIN);
    let min_y = work_pos.y + SCREEN_MARGIN;
    let max_y = work_pos.y + work_size.height - height - MASCOT_REST_BOTTOM_MARGIN;
    let x = if peek {
        work_pos.x + work_size.width - MASCOT_PEEK_VISIBLE_WIDTH
    } else {
        work_pos.x + work_size.width - width - MASCOT_REST_RIGHT_MARGIN
    };

    Some(LogicalPosition {
        x,
        y: current_y.clamp(min_y, max_y.max(min_y)),
    })
}

fn dock_mascot_immediately(
    window: &tauri::WebviewWindow,
    motion: &MascotDockMotion,
    width: f64,
    height: f64,
) {
    motion.cancel();
    if let Some(target) = mascot_dock_target(window, width, height, false) {
        let _ = window.set_position(Position::Logical(target));
    }
}

fn mascot_is_partly_offscreen(window: &tauri::WebviewWindow, width: f64) -> bool {
    let Ok(Some(monitor)) = window.current_monitor() else {
        return false;
    };
    let scale = monitor.scale_factor();
    let work_size = monitor.work_area().size.to_logical::<f64>(scale);
    let work_pos = monitor.work_area().position.to_logical::<f64>(scale);
    let Ok(position) = window.outer_position() else {
        return false;
    };
    let position = position.to_logical::<f64>(scale);
    should_restore_peeked_position(position.x, width, work_pos.x + work_size.width)
}

fn should_restore_peeked_position(position_x: f64, width: f64, work_right: f64) -> bool {
    position_x + width > work_right + 1.0
}

#[cfg(test)]
mod mascot_position_tests {
    use super::{async_key_state_is_pressed, should_restore_peeked_position};

    #[test]
    fn visible_dragged_positions_are_never_forced_back_to_the_initial_dock() {
        assert!(!should_restore_peeked_position(420.0, 168.0, 1920.0));
        assert!(!should_restore_peeked_position(1722.0, 168.0, 1920.0));
    }

    #[test]
    fn only_the_deliberate_offscreen_peek_is_restored() {
        assert!(should_restore_peeked_position(1816.0, 168.0, 1920.0));
    }

    #[test]
    fn native_mouse_state_uses_the_high_order_pressed_bit() {
        assert!(async_key_state_is_pressed(i16::MIN));
        assert!(async_key_state_is_pressed(-1));
        assert!(!async_key_state_is_pressed(0));
        assert!(!async_key_state_is_pressed(1));
    }
}

fn restore_mascot_if_peeked(
    window: &tauri::WebviewWindow,
    motion: &MascotDockMotion,
    width: f64,
    height: f64,
) {
    // Normal clicks and events must keep the user's dragged position. Only a
    // window that is actually beyond the work area is the deliberate peeked
    // state and may be restored to the right edge.
    if mascot_is_partly_offscreen(window, width) {
        dock_mascot_immediately(window, motion, width, height);
    }
}

fn animate_mascot_dock(
    window: tauri::WebviewWindow,
    motion: MascotDockMotion,
    width: f64,
    height: f64,
    peek: bool,
    reduced_motion: bool,
) {
    let Some(target) = mascot_dock_target(&window, width, height, peek) else {
        return;
    };
    let scale = window.scale_factor().unwrap_or(1.0);
    let Ok(start) = window.outer_position() else {
        let _ = window.set_position(Position::Logical(target));
        return;
    };
    let start = start.to_logical::<f64>(scale);
    let animation_token = motion.cancel();

    if reduced_motion {
        let _ = window.set_position(Position::Logical(target));
        return;
    }

    let animation_steps = if peek {
        MASCOT_PEEK_ANIMATION_STEPS
    } else {
        MASCOT_REVEAL_ANIMATION_STEPS
    };

    thread::spawn(move || {
        for step in 1..=animation_steps {
            if motion.0.load(Ordering::SeqCst) != animation_token {
                return;
            }
            let progress = step as f64 / animation_steps as f64;
            let eased = if peek {
                // Hiding should stay quiet and unobtrusive, with zero velocity
                // at both ends as the mascot slips behind the desktop edge.
                progress.powi(3) * (progress * (progress * 6.0 - 15.0) + 10.0)
            } else {
                // Hover reveal needs to respond immediately. A restrained back
                // easing overshoots by only a few pixels before settling.
                const BACK: f64 = 0.6;
                let shifted = progress - 1.0;
                1.0 + (BACK + 1.0) * shifted.powi(3) + BACK * shifted.powi(2)
            };
            let position = LogicalPosition {
                x: start.x + (target.x - start.x) * eased,
                y: start.y + (target.y - start.y) * eased,
            };
            let _ = window.set_position(Position::Logical(position));
            thread::sleep(Duration::from_millis(MASCOT_DOCK_ANIMATION_FRAME_MS));
        }
    });
}

fn resize_mascot_for_notification(window: &tauri::WebviewWindow, visible: bool, compact: bool) {
    let (target_width, target_height) = if !visible {
        (MASCOT_WIDTH, MASCOT_HEIGHT)
    } else if compact {
        (MASCOT_MESSAGE_WIDTH, MASCOT_MESSAGE_HEIGHT)
    } else {
        (MASCOT_NOTIFICATION_WIDTH, MASCOT_NOTIFICATION_HEIGHT)
    };
    let scale = window.scale_factor().unwrap_or(1.0);
    let current_size = window
        .outer_size()
        .ok()
        .map(|size| size.to_logical::<f64>(scale));

    let next_position = if let (Some(size), Ok(position)) = (current_size, window.outer_position())
    {
        let position = position.to_logical::<f64>(scale);
        let delta_x = (target_width - size.width) / 2.0;
        let delta_y = target_height - size.height;
        Some(LogicalPosition {
            x: position.x - delta_x,
            y: position.y - delta_y,
        })
    } else {
        None
    };

    // Windows WebView2 在连续缩放时需要先更新窗口尺寸，再恢复右下角锚点。
    // 否则位置先变、尺寸后变的瞬间可能让透明 WebView 裁掉一部分角色。
    let _ = window.set_size(Size::Logical(LogicalSize {
        width: target_width,
        height: target_height,
    }));
    if let Some(position) = next_position {
        let _ = window.set_position(Position::Logical(position));
    }
}

fn panel_height(expanded: bool) -> f64 {
    if expanded {
        PANEL_EXPANDED_HEIGHT
    } else {
        PANEL_COMPACT_HEIGHT
    }
}

fn place_panel_near_mascot(
    panel: &tauri::WebviewWindow,
    mascot: &tauri::WebviewWindow,
    expanded: bool,
) {
    let height = panel_height(expanded);
    let _ = panel.set_size(Size::Logical(LogicalSize {
        width: PANEL_WIDTH,
        height,
    }));

    if let Ok(mascot_pos) = mascot.outer_position() {
        let scale = mascot.scale_factor().unwrap_or(1.0);
        let mascot_pos = mascot_pos.to_logical::<f64>(scale);
        let (mascot_width, _mascot_height) = mascot_logical_size(mascot);
        let (min_x, max_x) = if let Ok(Some(monitor)) = mascot.current_monitor() {
            let screen_size = monitor.work_area().size.to_logical::<f64>(scale);
            let screen_pos = monitor.work_area().position.to_logical::<f64>(scale);
            (
                screen_pos.x + SCREEN_MARGIN,
                screen_pos.x + screen_size.width - PANEL_WIDTH - SCREEN_MARGIN,
            )
        } else {
            (SCREEN_MARGIN, f64::MAX)
        };
        let raw_x = mascot_pos.x + (mascot_width - PANEL_WIDTH) / 2.0;
        let x = raw_x.clamp(min_x, max_x.max(min_x));
        let y = (mascot_pos.y - height + PANEL_GAP).max(SCREEN_MARGIN);
        let _ = panel.set_position(Position::Logical(LogicalPosition { x, y }));
        return;
    }

    place_bottom_right(panel, PANEL_WIDTH, height);
}

#[tauri::command]
fn hide_main_window(app: tauri::AppHandle) {
    if let Some(window) = app.get_webview_window("mascot") {
        let _ = window.hide();
    }
    if let Some(window) = app.get_webview_window("panel") {
        let _ = window.hide();
    }
}

#[tauri::command]
fn show_main_window(app: tauri::AppHandle, motion: tauri::State<'_, MascotDockMotion>) {
    if let Some(window) = app.get_webview_window("mascot") {
        let (width, height) = mascot_logical_size(&window);
        restore_mascot_if_peeked(&window, motion.inner(), width, height);
        let _ = window.show();
        let _ = window.set_focus();
    }
}

#[tauri::command]
fn show_notification_window(app: tauri::AppHandle, motion: tauri::State<'_, MascotDockMotion>) {
    if let Some(window) = app.get_webview_window("mascot") {
        // A reminder should become visible without stealing focus from the
        // document or business application the user is working in.
        let (width, height) = mascot_logical_size(&window);
        restore_mascot_if_peeked(&window, motion.inner(), width, height);
        let _ = window.show();
    }
}

#[tauri::command]
fn peek_mascot_window(
    app: tauri::AppHandle,
    motion: tauri::State<'_, MascotDockMotion>,
    reduced_motion: bool,
) {
    if let Some(window) = app.get_webview_window("mascot") {
        let (width, height) = mascot_logical_size(&window);
        // Expanded reminders and menus must remain fully visible until handled.
        if width > MASCOT_WIDTH + 1.0 || height > MASCOT_HEIGHT + 1.0 {
            return;
        }
        if let Some(panel) = app.get_webview_window("panel") {
            let _ = panel.hide();
        }
        animate_mascot_dock(
            window,
            motion.inner().clone(),
            MASCOT_WIDTH,
            MASCOT_HEIGHT,
            true,
            reduced_motion,
        );
    }
}

#[tauri::command]
fn reveal_mascot_window(
    app: tauri::AppHandle,
    motion: tauri::State<'_, MascotDockMotion>,
    reduced_motion: bool,
) {
    if let Some(window) = app.get_webview_window("mascot") {
        let (width, height) = mascot_logical_size(&window);
        let _ = window.show();
        animate_mascot_dock(
            window,
            motion.inner().clone(),
            width,
            height,
            false,
            reduced_motion,
        );
    }
}

#[tauri::command]
fn start_mascot_drag(
    app: tauri::AppHandle,
    monitor: tauri::State<'_, MascotDragMonitor>,
) -> Result<(), String> {
    let window = app
        .get_webview_window("mascot")
        .ok_or_else(|| "mascot window is unavailable".to_string())?;
    let token = monitor.start();
    window.start_dragging().map_err(|error| error.to_string())?;

    #[cfg(windows)]
    monitor_native_drag_end(app, monitor.inner().clone(), token);
    #[cfg(not(windows))]
    let _ = (app, token);

    Ok(())
}

#[tauri::command]
fn toggle_panel_window(app: tauri::AppHandle, motion: tauri::State<'_, MascotDockMotion>) {
    if let (Some(panel), Some(mascot)) = (
        app.get_webview_window("panel"),
        app.get_webview_window("mascot"),
    ) {
        if matches!(panel.is_visible(), Ok(true)) {
            let _ = panel.hide();
        } else {
            let (width, height) = mascot_logical_size(&mascot);
            restore_mascot_if_peeked(&mascot, motion.inner(), width, height);
            place_panel_near_mascot(&panel, &mascot, false);
            let _ = panel.show();
            let _ = panel.set_focus();
        }
    }
}

#[tauri::command]
fn show_panel_window(app: tauri::AppHandle, motion: tauri::State<'_, MascotDockMotion>) {
    if let (Some(panel), Some(mascot)) = (
        app.get_webview_window("panel"),
        app.get_webview_window("mascot"),
    ) {
        let (width, height) = mascot_logical_size(&mascot);
        restore_mascot_if_peeked(&mascot, motion.inner(), width, height);
        place_panel_near_mascot(&panel, &mascot, false);
        let _ = panel.show();
        let _ = panel.set_focus();
    }
}

#[tauri::command]
fn hide_panel_window(app: tauri::AppHandle) {
    if let Some(panel) = app.get_webview_window("panel") {
        let _ = panel.hide();
    }
}

#[tauri::command]
fn sync_panel_window(app: tauri::AppHandle) {
    sync_panel_if_visible(&app);
}

#[tauri::command]
fn set_mascot_notification_visible(
    app: tauri::AppHandle,
    motion: tauri::State<'_, MascotDockMotion>,
    visible: bool,
    compact: Option<bool>,
) {
    if let Some(window) = app.get_webview_window("mascot") {
        let compact = compact.unwrap_or(false);
        motion.cancel();
        if visible {
            let (current_width, current_height) = mascot_logical_size(&window);
            restore_mascot_if_peeked(&window, motion.inner(), current_width, current_height);
        }
        resize_mascot_for_notification(&window, visible, compact);
    }
}

#[tauri::command]
fn set_panel_expanded(app: tauri::AppHandle, expanded: bool) {
    if let (Some(panel), Some(mascot)) = (
        app.get_webview_window("panel"),
        app.get_webview_window("mascot"),
    ) {
        place_panel_near_mascot(&panel, &mascot, expanded);
    }
}

#[tauri::command]
fn exit_app(app: tauri::AppHandle) {
    app.exit(0);
}

fn is_http_url(url: &str) -> bool {
    url.starts_with("http://") || url.starts_with("https://")
}

#[cfg(target_os = "macos")]
fn focus_existing_browser_tab(url: &str, match_url: &str) -> bool {
    let script = r##"
on run argv
  set targetUrl to item 1 of argv
  set matchUrl to item 2 of argv

  if my focusChromium("Google Chrome", targetUrl, matchUrl) then return "reused"
  if my focusChromium("Microsoft Edge", targetUrl, matchUrl) then return "reused"
  if my focusChromium("Brave Browser", targetUrl, matchUrl) then return "reused"
  if my focusChromium("Arc", targetUrl, matchUrl) then return "reused"
  if my focusSafari(targetUrl, matchUrl) then return "reused"

  return "not_found"
end run

on isMatchingUrl(currentUrl, matchUrl)
  if currentUrl is missing value then return false
  if currentUrl is equal to matchUrl then return true
  if currentUrl starts with (matchUrl & "/") then return true
  if currentUrl starts with (matchUrl & "?") then return true
  if currentUrl starts with (matchUrl & "#") then return true
  return false
end isMatchingUrl

on focusChromium(browserName, targetUrl, matchUrl)
  try
    if application browserName is not running then return false
    using terms from application "Google Chrome"
      tell application browserName
        repeat with browserWindow in windows
          set tabIndex to 1
          repeat with browserTab in tabs of browserWindow
            set currentUrl to URL of browserTab
            if my isMatchingUrl(currentUrl, matchUrl) then
              set active tab index of browserWindow to tabIndex
              set index of browserWindow to 1
              set URL of browserTab to targetUrl
              activate
              return true
            end if
            set tabIndex to tabIndex + 1
          end repeat
        end repeat
      end tell
    end using terms from
  end try
  return false
end focusChromium

on focusSafari(targetUrl, matchUrl)
  try
    if application "Safari" is not running then return false
    tell application "Safari"
      repeat with browserWindow in windows
        repeat with browserTab in tabs of browserWindow
          set currentUrl to URL of browserTab
          if my isMatchingUrl(currentUrl, matchUrl) then
            set current tab of browserWindow to browserTab
            set index of browserWindow to 1
            set URL of browserTab to targetUrl
            activate
            return true
          end if
        end repeat
      end repeat
    end tell
  end try
  return false
end focusSafari
"##;

    let Ok(output) = Command::new("osascript")
        .arg("-e")
        .arg(script)
        .arg(url)
        .arg(match_url)
        .output()
    else {
        return false;
    };

    output.status.success() && String::from_utf8_lossy(&output.stdout).trim() == "reused"
}

#[cfg(target_os = "windows")]
fn focus_existing_browser_tab(url: &str, match_url: &str) -> bool {
    const CREATE_NO_WINDOW: u32 = 0x08000000;
    let script = r##"
param([string]$TargetUrl, [string]$MatchUrl)

$ErrorActionPreference = 'SilentlyContinue'
Add-Type -AssemblyName UIAutomationClient
Add-Type -AssemblyName UIAutomationTypes
Add-Type -AssemblyName System.Windows.Forms
Add-Type @'
using System;
using System.Runtime.InteropServices;
public static class HualiBrowserWindow {
  [DllImport("user32.dll")]
  public static extern bool SetForegroundWindow(IntPtr hWnd);
}
'@

function Test-HualiUrlMatch([string]$CurrentUrl, [string]$BaseUrl) {
  if ([string]::IsNullOrWhiteSpace($CurrentUrl)) { return $false }
  $current = $CurrentUrl.TrimEnd('/')
  $base = $BaseUrl.TrimEnd('/')
  return $current -eq $base -or
    $current.StartsWith($base + '/') -or
    $current.StartsWith($base + '?') -or
    $current.StartsWith($base + '#')
}

function Get-HualiAddressBar($Root) {
  $condition = New-Object System.Windows.Automation.PropertyCondition(
    [System.Windows.Automation.AutomationElement]::ControlTypeProperty,
    [System.Windows.Automation.ControlType]::Edit
  )
  $edits = $Root.FindAll([System.Windows.Automation.TreeScope]::Descendants, $condition)
  foreach ($edit in $edits) {
    try {
      $pattern = $edit.GetCurrentPattern([System.Windows.Automation.ValuePattern]::Pattern)
      $value = $pattern.Current.Value
      if ($value -match '^https?://') {
        return [PSCustomObject]@{ Element = $edit; Pattern = $pattern; Value = $value }
      }
    } catch {}
  }
  return $null
}

$processes = Get-Process -Name msedge, chrome, brave, firefox -ErrorAction SilentlyContinue |
  Where-Object { $_.MainWindowHandle -ne 0 } |
  Sort-Object Id -Unique

foreach ($process in $processes) {
  try {
    $root = [System.Windows.Automation.AutomationElement]::FromHandle($process.MainWindowHandle)
    if ($null -eq $root) { continue }

    $tabCondition = New-Object System.Windows.Automation.PropertyCondition(
      [System.Windows.Automation.AutomationElement]::ControlTypeProperty,
      [System.Windows.Automation.ControlType]::TabItem
    )
    $tabs = $root.FindAll([System.Windows.Automation.TreeScope]::Descendants, $tabCondition)
    $originalTab = $null

    foreach ($tab in $tabs) {
      try {
        $selection = $tab.GetCurrentPattern([System.Windows.Automation.SelectionItemPattern]::Pattern)
        if ($selection.Current.IsSelected) { $originalTab = $selection }
        $selection.Select()
        Start-Sleep -Milliseconds 70
        $addressBar = Get-HualiAddressBar $root
        if ($null -ne $addressBar -and (Test-HualiUrlMatch $addressBar.Value $MatchUrl)) {
          [HualiBrowserWindow]::SetForegroundWindow($process.MainWindowHandle) | Out-Null
          $addressBar.Pattern.SetValue($TargetUrl)
          $addressBar.Element.SetFocus()
          [System.Windows.Forms.SendKeys]::SendWait('{ENTER}')
          Write-Output 'reused'
          exit 0
        }
      } catch {}
    }

    if ($null -ne $originalTab) { $originalTab.Select() }

    if ($tabs.Count -eq 0) {
      $addressBar = Get-HualiAddressBar $root
      if ($null -ne $addressBar -and (Test-HualiUrlMatch $addressBar.Value $MatchUrl)) {
        [HualiBrowserWindow]::SetForegroundWindow($process.MainWindowHandle) | Out-Null
        $addressBar.Pattern.SetValue($TargetUrl)
        $addressBar.Element.SetFocus()
        [System.Windows.Forms.SendKeys]::SendWait('{ENTER}')
        Write-Output 'reused'
        exit 0
      }
    }
  } catch {}
}

Write-Output 'not_found'
"##;

    let Ok(output) = Command::new("powershell.exe")
        .args([
            "-NoProfile",
            "-NonInteractive",
            "-WindowStyle",
            "Hidden",
            "-ExecutionPolicy",
            "Bypass",
            "-Command",
            script,
            url,
            match_url,
        ])
        .creation_flags(CREATE_NO_WINDOW)
        .output()
    else {
        return false;
    };

    output.status.success() && String::from_utf8_lossy(&output.stdout).trim() == "reused"
}

#[cfg(not(any(target_os = "macos", windows)))]
fn focus_existing_browser_tab(_url: &str, _match_url: &str) -> bool {
    false
}

#[tauri::command]
async fn open_or_focus_web_url(url: String, match_url: String) -> bool {
    if !is_http_url(&url) || !is_http_url(&match_url) {
        return false;
    }

    tauri::async_runtime::spawn_blocking(move || focus_existing_browser_tab(&url, &match_url))
        .await
        .unwrap_or(false)
}

fn main() {
    let startup_args = std::env::args().collect::<Vec<_>>();
    if let Some(callback_url) = find_desktop_auth_callback(&startup_args) {
        persist_startup_desktop_auth_callback(&callback_url);
    }

    let pending_desktop_auth = PendingDesktopAuthCallback::default();
    let single_instance_desktop_auth = pending_desktop_auth.clone();

    tauri::Builder::default()
        .manage(pending_desktop_auth)
        .plugin(tauri_plugin_single_instance::init(
            move |app, argv, _cwd| {
                if let Some(callback_url) = single_instance_desktop_auth.capture(&argv) {
                    let _ = app.emit("desktop-auth-callback", callback_url);
                }

                if let Some(window) = app.get_webview_window("mascot") {
                    let motion = app.state::<MascotDockMotion>();
                    let (width, height) = mascot_logical_size(&window);
                    restore_mascot_if_peeked(&window, motion.inner(), width, height);
                    let _ = window.show();
                    let _ = window.set_focus();
                }
            },
        ))
        .plugin(tauri_plugin_deep_link::init())
        .plugin(tauri_plugin_http::init())
        .plugin(tauri_plugin_opener::init())
        .manage(MascotDockMotion::default())
        .manage(MascotDragMonitor::default())
        .invoke_handler(tauri::generate_handler![
            hide_main_window,
            show_main_window,
            show_notification_window,
            peek_mascot_window,
            reveal_mascot_window,
            start_mascot_drag,
            toggle_panel_window,
            show_panel_window,
            hide_panel_window,
            sync_panel_window,
            set_mascot_notification_visible,
            set_panel_expanded,
            exit_app,
            open_or_focus_web_url,
            take_desktop_auth_callback
        ])
        .setup(|app| {
            let startup_args = std::env::args().collect::<Vec<_>>();
            app.state::<PendingDesktopAuthCallback>()
                .capture(&startup_args);

            #[cfg(any(windows, target_os = "linux"))]
            {
                use tauri_plugin_deep_link::DeepLinkExt;
                if let Err(error) = app.deep_link().register_all() {
                    eprintln!("deep link register failed: {error}");
                }
            }

            if let Some(window) = app.get_webview_window("mascot") {
                harden_transparent_window(&window);
                place_mascot_bottom_right(&window);
            }
            if let Some(window) = app.get_webview_window("panel") {
                harden_transparent_window(&window);
            }

            let open = MenuItem::with_id(app, "open_workbench", "打开工作台", true, None::<&str>)?;
            let show = MenuItem::with_id(app, "show", "显示助手", true, None::<&str>)?;
            let hide = MenuItem::with_id(app, "hide", "隐藏助手", true, None::<&str>)?;
            let logout = MenuItem::with_id(app, "logout", "退出登录", true, None::<&str>)?;
            let quit = MenuItem::with_id(app, "quit", "退出", true, None::<&str>)?;
            let menu = Menu::with_items(app, &[&open, &show, &hide, &logout, &quit])?;

            // Embed a dedicated small icon instead of relying on the optional
            // default window icon. This keeps the Windows notification-area
            // icon visible even when a platform does not expose a default.
            let tray_icon = tauri::image::Image::from_bytes(include_bytes!("../icons/32x32.png"))?;

            TrayIconBuilder::new()
                .icon(tray_icon)
                .tooltip("华力 AI 桌面助手")
                .menu(&menu)
                .show_menu_on_left_click(true)
                .on_menu_event(|app, event| match event.id().as_ref() {
                    "open_workbench" => {
                        let _ = app.emit("tray-open-workbench", ());
                    }
                    "show" => {
                        if let Some(window) = app.get_webview_window("mascot") {
                            let motion = app.state::<MascotDockMotion>();
                            let (width, height) = mascot_logical_size(&window);
                            restore_mascot_if_peeked(&window, motion.inner(), width, height);
                            let _ = window.show();
                            let _ = window.set_focus();
                        }
                    }
                    "hide" => {
                        if let Some(window) = app.get_webview_window("mascot") {
                            let _ = window.hide();
                        }
                        if let Some(window) = app.get_webview_window("panel") {
                            let _ = window.hide();
                        }
                    }
                    "logout" => {
                        let _ = app.emit("tray-logout", ());
                    }
                    "quit" => app.exit(0),
                    _ => {}
                })
                .build(app)?;

            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("error while running huali ai mascot");
}
