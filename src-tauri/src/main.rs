use std::process::Command;
use tauri::menu::{Menu, MenuItem};
use tauri::tray::TrayIconBuilder;
use tauri::window::Color;
use tauri::{Emitter, LogicalPosition, LogicalSize, Manager, Position, Size};

const MASCOT_WIDTH: f64 = 168.0;
const MASCOT_HEIGHT: f64 = 168.0;
const MASCOT_NOTIFICATION_WIDTH: f64 = 300.0;
const MASCOT_NOTIFICATION_HEIGHT: f64 = 348.0;
const MASCOT_MESSAGE_WIDTH: f64 = 200.0;
const MASCOT_MESSAGE_HEIGHT: f64 = 232.0;
const PANEL_WIDTH: f64 = 390.0;
const PANEL_COMPACT_HEIGHT: f64 = 118.0;
const PANEL_EXPANDED_HEIGHT: f64 = 118.0;
const SCREEN_MARGIN: f64 = 24.0;
const PANEL_GAP: f64 = 14.0;
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
        let screen_size = monitor.size().to_logical::<f64>(scale);
        let screen_pos = monitor.position().to_logical::<f64>(scale);
        let x = screen_pos.x + screen_size.width - width - SCREEN_MARGIN;
        let y = screen_pos.y + screen_size.height - height - SCREEN_MARGIN;
        let _ = window.set_position(Position::Logical(LogicalPosition { x, y }));
    }
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

    if let (Some(size), Ok(position)) = (current_size, window.outer_position()) {
        let position = position.to_logical::<f64>(scale);
        let delta_x = (target_width - size.width) / 2.0;
        let delta_y = target_height - size.height;
        let _ = window.set_position(Position::Logical(LogicalPosition {
            x: position.x - delta_x,
            y: position.y - delta_y,
        }));
    }

    let _ = window.set_size(Size::Logical(LogicalSize {
        width: target_width,
        height: target_height,
    }));
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
            let screen_size = monitor.size().to_logical::<f64>(scale);
            let screen_pos = monitor.position().to_logical::<f64>(scale);
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
fn set_mascot_position(app: tauri::AppHandle, x: f64, y: f64) {
    if let Some(mascot) = app.get_webview_window("mascot") {
        let _ = mascot.set_position(Position::Logical(LogicalPosition { x, y }));
        sync_panel_if_visible(&app);
    }
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
fn show_main_window(app: tauri::AppHandle) {
    if let Some(window) = app.get_webview_window("mascot") {
        place_bottom_right(&window, MASCOT_WIDTH, MASCOT_HEIGHT);
        let _ = window.show();
        let _ = window.set_focus();
    }
}

#[tauri::command]
fn toggle_panel_window(app: tauri::AppHandle) {
    if let (Some(panel), Some(mascot)) = (
        app.get_webview_window("panel"),
        app.get_webview_window("mascot"),
    ) {
        if matches!(panel.is_visible(), Ok(true)) {
            let _ = panel.hide();
        } else {
            place_panel_near_mascot(&panel, &mascot, false);
            let _ = panel.show();
            let _ = panel.set_focus();
        }
    }
}

#[tauri::command]
fn show_panel_window(app: tauri::AppHandle) {
    if let (Some(panel), Some(mascot)) = (
        app.get_webview_window("panel"),
        app.get_webview_window("mascot"),
    ) {
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
fn set_mascot_notification_visible(app: tauri::AppHandle, visible: bool, compact: Option<bool>) {
    if let Some(window) = app.get_webview_window("mascot") {
        resize_mascot_for_notification(&window, visible, compact.unwrap_or(false));
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

#[cfg(not(target_os = "macos"))]
fn focus_existing_browser_tab(_url: &str, _match_url: &str) -> bool {
    false
}

#[tauri::command]
fn open_or_focus_web_url(url: String, match_url: String) -> bool {
    if !is_http_url(&url) || !is_http_url(&match_url) {
        return false;
    }

    focus_existing_browser_tab(&url, &match_url)
}

fn main() {
    tauri::Builder::default()
        .plugin(tauri_plugin_single_instance::init(|_app, _argv, _cwd| {}))
        .plugin(tauri_plugin_deep_link::init())
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_notification::init())
        .invoke_handler(tauri::generate_handler![
            hide_main_window,
            show_main_window,
            toggle_panel_window,
            show_panel_window,
            hide_panel_window,
            sync_panel_window,
            set_mascot_position,
            set_mascot_notification_visible,
            set_panel_expanded,
            exit_app,
            open_or_focus_web_url
        ])
        .setup(|app| {
            #[cfg(any(windows, target_os = "linux"))]
            {
                use tauri_plugin_deep_link::DeepLinkExt;
                if let Err(error) = app.deep_link().register_all() {
                    eprintln!("deep link register failed: {error}");
                }
            }

            if let Some(window) = app.get_webview_window("mascot") {
                harden_transparent_window(&window);
                place_bottom_right(&window, MASCOT_WIDTH, MASCOT_HEIGHT);
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

            TrayIconBuilder::new()
                .tooltip("华力 AI 桌面助手")
                .menu(&menu)
                .show_menu_on_left_click(true)
                .on_menu_event(|app, event| match event.id().as_ref() {
                    "open_workbench" => {
                        let _ = app.emit("tray-open-workbench", ());
                    }
                    "show" => {
                        if let Some(window) = app.get_webview_window("mascot") {
                            place_bottom_right(&window, MASCOT_WIDTH, MASCOT_HEIGHT);
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
