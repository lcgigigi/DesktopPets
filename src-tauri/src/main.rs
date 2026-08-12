#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use std::fs;
#[cfg(windows)]
use std::os::windows::process::CommandExt;
use std::path::PathBuf;
#[cfg(any(target_os = "macos", windows))]
use std::process::Command;
use std::sync::{
    atomic::{AtomicBool, AtomicU64, Ordering},
    Arc, Mutex,
};
use std::thread;
use std::time::{Duration, Instant};
use tauri::menu::{Menu, MenuItem};
use tauri::tray::TrayIconBuilder;
use tauri::window::Color;
use tauri::{Emitter, LogicalPosition, LogicalSize, Manager, Position, Size};

// Keep a transparent safety gutter around the sprite. WebView2 can otherwise
// clip the last physical pixel at 125%/150% Windows display scaling.
const MASCOT_WIDTH: f64 = 168.0;
const MASCOT_HEIGHT: f64 = 144.0;
const MASCOT_AVATAR_WIDTH: f64 = 144.0;
const MASCOT_AVATAR_HEIGHT: f64 = 128.0;
const MASCOT_NOTIFICATION_BOTTOM_PADDING: f64 = 8.0;
// Keep the same amount of the safety window visible when peeking from either
// desktop edge. This leaves a discoverable part of Xiaoli on screen.
const MASCOT_PEEK_VISIBLE_WIDTH: f64 = 96.0;
const MASCOT_PEEK_ANIMATION_DURATION_MS: u64 = 560;
const MASCOT_REVEAL_ANIMATION_DURATION_MS: u64 = 480;
const MASCOT_DOCK_ANIMATION_FRAME_MS: u64 = 12;
// WebView2 can report a fractional logical position after a DPI-aware resize.
// Treat that sub-pixel drift as resize noise instead of a user drag.
const MASCOT_NOTIFICATION_DRAG_EPSILON: f64 = 1.0;
const DESKTOP_AUTH_CALLBACK_PREFIX: &str = "huali-ai-mascot://auth-callback";
const DESKTOP_AUTH_CALLBACK_FILE: &str = "huali-ai-mascot-auth-callback.tmp";
const PANEL_VISIBILITY_EVENT: &str = "huali:panel-visibility";

#[derive(Clone, Default)]
struct PendingDesktopAuthCallback(Arc<Mutex<Option<NativeDesktopAuthCallback>>>);

#[derive(Clone, Default)]
struct MascotDockMotion(Arc<AtomicU64>);

#[derive(Clone)]
struct InitialMascotPlacement(Arc<AtomicBool>);

impl Default for InitialMascotPlacement {
    fn default() -> Self {
        Self(Arc::new(AtomicBool::new(true)))
    }
}

impl MascotDockMotion {
    fn cancel(&self) -> u64 {
        self.0.fetch_add(1, Ordering::SeqCst) + 1
    }
}

#[derive(Clone, Copy)]
struct MascotNotificationLayout {
    restore_position: LogicalPosition<f64>,
    expanded_position: LogicalPosition<f64>,
}

#[derive(Clone, Default)]
struct MascotNotificationLayoutState(Arc<Mutex<Option<MascotNotificationLayout>>>);

#[derive(Clone, Default)]
struct MascotDragMonitor(Arc<AtomicU64>);

#[derive(Clone, Copy, Default)]
struct PanelActivity {
    has_text: bool,
    focused: bool,
}

#[derive(Clone, Default)]
struct PanelActivityState(Arc<Mutex<PanelActivity>>);

impl PanelActivityState {
    fn set(&self, has_text: bool, focused: bool) {
        if let Ok(mut activity) = self.0.lock() {
            *activity = PanelActivity { has_text, focused };
        }
    }

    fn is_engaged(&self) -> bool {
        self.0
            .lock()
            .map(|activity| activity.has_text || activity.focused)
            .unwrap_or(false)
    }
}

impl MascotDragMonitor {
    fn start(&self) -> u64 {
        self.0.fetch_add(1, Ordering::SeqCst) + 1
    }
}

fn async_key_state_is_pressed(state: i16) -> bool {
    state as u16 & 0x8000 != 0
}

#[cfg(windows)]
fn monitor_native_drag(app: tauri::AppHandle, monitor: MascotDragMonitor, token: u64) {
    use windows_sys::Win32::UI::Input::KeyboardAndMouse::{GetAsyncKeyState, VK_LBUTTON};

    thread::spawn(move || loop {
        if monitor.0.load(Ordering::SeqCst) != token {
            return;
        }

        sync_visible_panel_to_mascot(&app);
        let button_state = unsafe { GetAsyncKeyState(VK_LBUTTON as i32) };
        if !async_key_state_is_pressed(button_state) {
            sync_visible_panel_to_mascot(&app);
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
const MASCOT_NOTIFICATION_HEIGHT: f64 = 480.0;
// Compact overlays need enough transparent safety space for the context menu,
// its tail and shadow at every Windows DPI. 240x224 keeps a deliberate visual
// gap above the mascot while preserving the same 8px bottom safety gutter as
// the collapsed and expanded layouts.
const MASCOT_MESSAGE_WIDTH: f64 = 240.0;
const MASCOT_MESSAGE_HEIGHT: f64 = 224.0;
const PANEL_WIDTH: f64 = 380.0;
const PANEL_COMPACT_HEIGHT: f64 = 78.0;
const PANEL_MAX_HEIGHT: f64 = 240.0;
const SCREEN_MARGIN: f64 = 24.0;
const MASCOT_REST_RIGHT_MARGIN: f64 = 30.0;
const MASCOT_REST_BOTTOM_MARGIN: f64 = 38.0;
const PANEL_GAP: f64 = 8.0;
const TRANSPARENT: Option<Color> = Some(Color(0, 0, 0, 0));

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum MascotDockSide {
    Left,
    Right,
}

impl MascotDockSide {
    fn as_str(self) -> &'static str {
        match self {
            Self::Left => "left",
            Self::Right => "right",
        }
    }
}

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
            place_panel_near_mascot(&panel, &mascot, current_panel_height(&panel));
        }
    }
}

fn place_bottom_right(window: &tauri::WebviewWindow, width: f64, height: f64) {
    let _ = window.set_size(Size::Logical(LogicalSize { width, height }));

    let monitor = window
        .current_monitor()
        .ok()
        .flatten()
        .or_else(|| window.primary_monitor().ok().flatten());
    if let Some(monitor) = monitor {
        let scale = monitor.scale_factor();
        let screen_size = monitor.work_area().size.to_logical::<f64>(scale);
        let screen_pos = monitor.work_area().position.to_logical::<f64>(scale);
        let x = screen_pos.x + screen_size.width - width - SCREEN_MARGIN;
        let y = screen_pos.y + screen_size.height - height - SCREEN_MARGIN;
        let _ = window.set_position(Position::Logical(LogicalPosition { x, y }));
    }
}

fn mascot_bottom_right_position(
    work_pos: LogicalPosition<f64>,
    work_size: LogicalSize<f64>,
) -> LogicalPosition<f64> {
    LogicalPosition {
        x: work_pos.x + work_size.width - MASCOT_WIDTH - MASCOT_REST_RIGHT_MARGIN,
        y: work_pos.y + work_size.height - MASCOT_HEIGHT - MASCOT_REST_BOTTOM_MARGIN,
    }
}

fn place_mascot_bottom_right(window: &tauri::WebviewWindow) -> bool {
    // The configured window already starts at the collapsed mascot size.
    // Do not set it again here: the frontend may have already expanded the
    // window for its first login/message card, and a late startup resize would
    // clip that card down to a single horizontal border above the mascot.
    let Some(monitor) = window
        .current_monitor()
        .ok()
        .flatten()
        .or_else(|| window.primary_monitor().ok().flatten())
    else {
        return false;
    };
    let scale = monitor.scale_factor();
    let work_size = monitor.work_area().size.to_logical::<f64>(scale);
    let work_pos = monitor.work_area().position.to_logical::<f64>(scale);
    let collapsed_position = mascot_bottom_right_position(work_pos, work_size);
    let collapsed_offset = mascot_avatar_offset(MASCOT_WIDTH, MASCOT_HEIGHT, false, false);
    let (width, height) = mascot_logical_size(window);
    let visible = width > MASCOT_WIDTH + 1.0 || height > MASCOT_HEIGHT + 1.0;
    let compact =
        visible && width <= MASCOT_MESSAGE_WIDTH + 1.0 && height <= MASCOT_MESSAGE_HEIGHT + 1.0;
    let current_offset = mascot_avatar_offset(width, height, visible, compact);
    let position = clamp_position_to_rect(
        align_window_to_avatar(collapsed_position, collapsed_offset, current_offset),
        width,
        height,
        work_pos,
        work_size,
    );

    window.set_position(Position::Logical(position)).is_ok()
}

fn ensure_initial_mascot_placement(window: &tauri::WebviewWindow, state: &InitialMascotPlacement) {
    if state.0.load(Ordering::SeqCst) && place_mascot_bottom_right(window) {
        state.0.store(false, Ordering::SeqCst);
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
    let current_x = window
        .outer_position()
        .ok()
        .map(|position| position.to_logical::<f64>(scale).x)
        .unwrap_or(work_pos.x + work_size.width - width - MASCOT_REST_RIGHT_MARGIN);
    let min_y = work_pos.y + SCREEN_MARGIN;
    let max_y = work_pos.y + work_size.height - height - MASCOT_REST_BOTTOM_MARGIN;
    let side = nearest_dock_side(current_x, width, work_pos.x, work_size.width);
    let x = mascot_dock_x(side, peek, width, work_pos.x, work_size.width);

    Some(LogicalPosition {
        x,
        y: current_y.clamp(min_y, max_y.max(min_y)),
    })
}

fn nearest_dock_side(
    position_x: f64,
    width: f64,
    work_left: f64,
    work_width: f64,
) -> MascotDockSide {
    let window_center = position_x + width / 2.0;
    let work_center = work_left + work_width / 2.0;
    if window_center <= work_center {
        MascotDockSide::Left
    } else {
        MascotDockSide::Right
    }
}

fn mascot_dock_x(
    side: MascotDockSide,
    peek: bool,
    width: f64,
    work_left: f64,
    work_width: f64,
) -> f64 {
    match (side, peek) {
        (MascotDockSide::Left, true) => work_left - width + MASCOT_PEEK_VISIBLE_WIDTH,
        (MascotDockSide::Left, false) => work_left + MASCOT_REST_RIGHT_MARGIN,
        (MascotDockSide::Right, true) => work_left + work_width - MASCOT_PEEK_VISIBLE_WIDTH,
        (MascotDockSide::Right, false) => work_left + work_width - width - MASCOT_REST_RIGHT_MARGIN,
    }
}

fn current_mascot_dock_side(window: &tauri::WebviewWindow, width: f64) -> Option<MascotDockSide> {
    let monitor = window.current_monitor().ok().flatten()?;
    let scale = monitor.scale_factor();
    let work_size = monitor.work_area().size.to_logical::<f64>(scale);
    let work_pos = monitor.work_area().position.to_logical::<f64>(scale);
    let position = window.outer_position().ok()?.to_logical::<f64>(scale);
    Some(nearest_dock_side(
        position.x,
        width,
        work_pos.x,
        work_size.width,
    ))
}

fn clamp_position_to_work_area(
    window: &tauri::WebviewWindow,
    position: LogicalPosition<f64>,
    width: f64,
    height: f64,
) -> LogicalPosition<f64> {
    let Ok(Some(monitor)) = window.current_monitor() else {
        return position;
    };
    let scale = monitor.scale_factor();
    let work_size = monitor.work_area().size.to_logical::<f64>(scale);
    let work_pos = monitor.work_area().position.to_logical::<f64>(scale);
    clamp_position_to_rect(position, width, height, work_pos, work_size)
}

fn fit_notification_size_to_work_area(
    window: &tauri::WebviewWindow,
    width: f64,
    height: f64,
) -> LogicalSize<f64> {
    let Ok(Some(monitor)) = window.current_monitor() else {
        return LogicalSize { width, height };
    };
    let scale = monitor.scale_factor();
    let work_size = monitor.work_area().size.to_logical::<f64>(scale);
    fit_notification_size_to_rect(width, height, work_size)
}

fn fit_notification_size_to_rect(
    width: f64,
    height: f64,
    work_size: LogicalSize<f64>,
) -> LogicalSize<f64> {
    // Prefer the normal screen margin, but on unusually small work areas keep
    // as much of the mascot as possible instead of letting the notification
    // window extend beyond the monitor and lose its top edge.
    let available_width =
        (work_size.width - SCREEN_MARGIN * 2.0).max(work_size.width.min(MASCOT_WIDTH));
    let available_height =
        (work_size.height - SCREEN_MARGIN * 2.0).max(work_size.height.min(MASCOT_HEIGHT));

    LogicalSize {
        width: width.min(available_width),
        height: height.min(available_height),
    }
}

fn clamp_position_to_rect(
    position: LogicalPosition<f64>,
    width: f64,
    height: f64,
    work_pos: LogicalPosition<f64>,
    work_size: LogicalSize<f64>,
) -> LogicalPosition<f64> {
    let min_x = work_pos.x + SCREEN_MARGIN;
    let min_y = work_pos.y + SCREEN_MARGIN;
    let max_x = work_pos.x + work_size.width - width - SCREEN_MARGIN;
    let max_y = work_pos.y + work_size.height - height - SCREEN_MARGIN;

    LogicalPosition {
        x: if max_x >= min_x {
            position.x.clamp(min_x, max_x)
        } else {
            work_pos.x + (work_size.width - width) / 2.0
        },
        y: if max_y >= min_y {
            position.y.clamp(min_y, max_y)
        } else {
            work_pos.y + (work_size.height - height) / 2.0
        },
    }
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
    peeked_dock_side(position.x, width, work_pos.x, work_pos.x + work_size.width).is_some()
}

fn peeked_dock_side(
    position_x: f64,
    width: f64,
    work_left: f64,
    work_right: f64,
) -> Option<MascotDockSide> {
    if position_x < work_left - 1.0 {
        Some(MascotDockSide::Left)
    } else if position_x + width > work_right + 1.0 {
        Some(MascotDockSide::Right)
    } else {
        None
    }
}

#[cfg(test)]
mod mascot_position_tests {
    use super::{
        align_window_to_avatar, async_key_state_is_pressed, clamp_position_to_rect,
        fit_notification_size_to_rect, fit_panel_height_to_rect, mascot_avatar_offset,
        mascot_bottom_right_position, mascot_dock_x, nearest_dock_side, notification_drag_delta,
        peeked_dock_side, target_outer_dimension, LogicalPosition, LogicalSize, MascotDockSide,
        PanelActivityState, MASCOT_AVATAR_HEIGHT, MASCOT_HEIGHT, MASCOT_MESSAGE_HEIGHT,
        MASCOT_MESSAGE_WIDTH, MASCOT_NOTIFICATION_BOTTOM_PADDING, MASCOT_NOTIFICATION_HEIGHT,
        MASCOT_NOTIFICATION_WIDTH, MASCOT_PEEK_VISIBLE_WIDTH, MASCOT_REST_BOTTOM_MARGIN,
        MASCOT_REST_RIGHT_MARGIN, MASCOT_WIDTH, PANEL_COMPACT_HEIGHT, PANEL_MAX_HEIGHT,
        SCREEN_MARGIN,
    };

    #[test]
    fn initial_mascot_position_uses_work_area_and_safe_edge_margins() {
        let work_pos = LogicalPosition { x: 1920.0, y: 0.0 };
        let work_size = LogicalSize {
            width: 1366.0,
            // The Windows taskbar is already excluded from this work area.
            height: 728.0,
        };
        let position = mascot_bottom_right_position(work_pos, work_size);

        assert_eq!(
            position.x,
            work_pos.x + work_size.width - MASCOT_WIDTH - MASCOT_REST_RIGHT_MARGIN
        );
        assert_eq!(
            position.y,
            work_pos.y + work_size.height - MASCOT_HEIGHT - MASCOT_REST_BOTTOM_MARGIN
        );
    }

    #[test]
    fn visible_dragged_positions_are_never_forced_back_to_the_initial_dock() {
        assert_eq!(peeked_dock_side(420.0, 168.0, 0.0, 1920.0), None);
        assert_eq!(peeked_dock_side(1722.0, 168.0, 0.0, 1920.0), None);
    }

    #[test]
    fn deliberate_peeks_are_detected_on_both_edges() {
        assert_eq!(
            peeked_dock_side(-72.0, 168.0, 0.0, 1920.0),
            Some(MascotDockSide::Left)
        );
        assert_eq!(
            peeked_dock_side(1824.0, 168.0, 0.0, 1920.0),
            Some(MascotDockSide::Right)
        );
    }

    #[test]
    fn nearest_screen_edge_controls_the_hide_direction() {
        assert_eq!(
            nearest_dock_side(120.0, MASCOT_WIDTH, 0.0, 1920.0),
            MascotDockSide::Left
        );
        assert_eq!(
            nearest_dock_side(1600.0, MASCOT_WIDTH, 0.0, 1920.0),
            MascotDockSide::Right
        );

        assert_eq!(
            mascot_dock_x(MascotDockSide::Left, true, MASCOT_WIDTH, 0.0, 1920.0),
            -MASCOT_WIDTH + MASCOT_PEEK_VISIBLE_WIDTH
        );
        assert_eq!(
            mascot_dock_x(MascotDockSide::Right, true, MASCOT_WIDTH, 0.0, 1920.0),
            1920.0 - MASCOT_PEEK_VISIBLE_WIDTH
        );
    }

    #[test]
    fn native_mouse_state_uses_the_high_order_pressed_bit() {
        assert!(async_key_state_is_pressed(i16::MIN));
        assert!(async_key_state_is_pressed(-1));
        assert!(!async_key_state_is_pressed(0));
        assert!(!async_key_state_is_pressed(1));
    }

    #[test]
    fn visible_todo_panel_activity_blocks_native_idle_hiding() {
        let state = PanelActivityState::default();
        assert!(!state.is_engaged());

        state.set(true, false);
        assert!(state.is_engaged());

        state.set(false, true);
        assert!(state.is_engaged());

        state.set(false, false);
        assert!(!state.is_engaged());
    }

    #[test]
    fn expanded_notification_is_kept_inside_the_monitor_work_area() {
        let work_pos = LogicalPosition { x: 0.0, y: 0.0 };
        let work_size = LogicalSize {
            width: 600.0,
            height: 720.0,
        };
        let clamped = clamp_position_to_rect(
            LogicalPosition { x: 326.0, y: 210.0 },
            MASCOT_NOTIFICATION_WIDTH,
            MASCOT_NOTIFICATION_HEIGHT,
            work_pos,
            work_size,
        );

        assert_eq!(clamped.x, 600.0 - MASCOT_NOTIFICATION_WIDTH - SCREEN_MARGIN);
        assert!(clamped.y >= SCREEN_MARGIN);
        assert!(clamped.y + MASCOT_NOTIFICATION_HEIGHT <= 720.0 - SCREEN_MARGIN);
    }

    #[test]
    fn notification_window_shrinks_to_fit_a_short_work_area() {
        let fitted = fit_notification_size_to_rect(
            MASCOT_NOTIFICATION_WIDTH,
            MASCOT_NOTIFICATION_HEIGHT,
            LogicalSize {
                width: 400.0,
                height: 420.0,
            },
        );

        assert_eq!(fitted.width, MASCOT_NOTIFICATION_WIDTH);
        assert_eq!(fitted.height, 420.0 - SCREEN_MARGIN * 2.0);
    }

    #[test]
    fn notification_window_fits_a_1366_by_768_laptop_at_150_percent_scaling() {
        // A 1366x768 display with a 40px taskbar exposes roughly this logical
        // work area at 150% Windows scaling.
        let work_size = LogicalSize {
            width: 1366.0 / 1.5,
            height: (768.0 - 40.0) / 1.5,
        };
        let fitted = fit_notification_size_to_rect(
            MASCOT_NOTIFICATION_WIDTH,
            MASCOT_NOTIFICATION_HEIGHT,
            work_size,
        );

        assert_eq!(fitted.width, MASCOT_NOTIFICATION_WIDTH);
        assert_eq!(fitted.height, work_size.height - SCREEN_MARGIN * 2.0);
        assert!(fitted.height < MASCOT_NOTIFICATION_HEIGHT);
    }

    #[test]
    fn notification_window_keeps_its_designed_size_when_space_is_available() {
        let fitted = fit_notification_size_to_rect(
            MASCOT_NOTIFICATION_WIDTH,
            MASCOT_NOTIFICATION_HEIGHT,
            LogicalSize {
                width: 1920.0,
                height: 1040.0,
            },
        );

        assert_eq!(fitted.width, MASCOT_NOTIFICATION_WIDTH);
        assert_eq!(fitted.height, MASCOT_NOTIFICATION_HEIGHT);
    }

    #[test]
    fn todo_panel_grows_with_wrapped_text_without_exceeding_its_limit() {
        assert_eq!(fit_panel_height_to_rect(78.0, 720.0), PANEL_COMPACT_HEIGHT);
        assert_eq!(fit_panel_height_to_rect(178.0, 720.0), 178.0);
        assert_eq!(fit_panel_height_to_rect(500.0, 720.0), PANEL_MAX_HEIGHT);
    }

    #[test]
    fn todo_panel_is_clamped_inside_a_short_laptop_work_area() {
        assert_eq!(
            fit_panel_height_to_rect(500.0, 220.0),
            220.0 - SCREEN_MARGIN * 2.0
        );
    }

    #[test]
    fn notification_and_collapsed_windows_share_the_same_avatar_anchor() {
        let collapsed_position = LogicalPosition {
            x: 1722.0,
            y: 858.0,
        };
        let collapsed_offset = mascot_avatar_offset(MASCOT_WIDTH, MASCOT_HEIGHT, false, false);
        let notification_offset = mascot_avatar_offset(
            MASCOT_NOTIFICATION_WIDTH,
            MASCOT_NOTIFICATION_HEIGHT,
            true,
            false,
        );
        let notification_position =
            align_window_to_avatar(collapsed_position, collapsed_offset, notification_offset);
        let restored_position =
            align_window_to_avatar(notification_position, notification_offset, collapsed_offset);

        assert_eq!(restored_position, collapsed_position);
    }

    #[test]
    fn collapsed_window_stays_under_a_clamped_notification_avatar() {
        let collapsed_offset = mascot_avatar_offset(MASCOT_WIDTH, MASCOT_HEIGHT, false, false);
        let notification_offset = mascot_avatar_offset(
            MASCOT_NOTIFICATION_WIDTH,
            MASCOT_NOTIFICATION_HEIGHT,
            true,
            false,
        );
        let clamped_notification_position = LogicalPosition {
            x: 1576.0,
            y: 376.0,
        };
        let restored_position = align_window_to_avatar(
            clamped_notification_position,
            notification_offset,
            collapsed_offset,
        );

        assert_eq!(
            restored_position.x + collapsed_offset.x,
            clamped_notification_position.x + notification_offset.x
        );
        assert_eq!(
            restored_position.y + collapsed_offset.y,
            clamped_notification_position.y + notification_offset.y
        );
    }

    #[test]
    fn compact_bubbles_keep_the_avatar_at_the_collapsed_anchor() {
        let collapsed_position = LogicalPosition { x: 500.0, y: 420.0 };
        let collapsed_offset = mascot_avatar_offset(MASCOT_WIDTH, MASCOT_HEIGHT, false, false);
        let compact_offset =
            mascot_avatar_offset(MASCOT_MESSAGE_WIDTH, MASCOT_MESSAGE_HEIGHT, true, true);
        let compact_position =
            align_window_to_avatar(collapsed_position, collapsed_offset, compact_offset);

        assert_eq!(
            compact_position.x + compact_offset.x,
            collapsed_position.x + collapsed_offset.x
        );
        assert_eq!(
            compact_position.y + compact_offset.y,
            collapsed_position.y + collapsed_offset.y
        );
    }

    #[test]
    fn atomic_windows_resize_preserves_the_non_client_frame_size() {
        assert_eq!(target_outer_dimension(168.0, 1.25, 416, 400), 226);
        assert_eq!(target_outer_dimension(144.0, 1.25, 616, 600), 196);
        assert_eq!(target_outer_dimension(168.0, 1.0, 168, 168), 168);
    }

    #[test]
    fn compact_overlay_has_exact_physical_bounds_across_supported_windows_dpi_scales() {
        for (scale, expected_width, expected_height) in [
            (1.0, 240, 224),
            (1.25, 300, 280),
            (1.5, 360, 336),
            (1.75, 420, 392),
            (2.0, 480, 448),
        ] {
            assert_eq!(
                target_outer_dimension(MASCOT_MESSAGE_WIDTH, scale, 100, 100),
                expected_width
            );
            assert_eq!(
                target_outer_dimension(MASCOT_MESSAGE_HEIGHT, scale, 100, 100),
                expected_height
            );
        }
    }

    #[test]
    fn compact_menu_fits_common_windows_laptop_work_areas() {
        for (screen_width, screen_height, taskbar_height, scale) in [
            (1366.0, 768.0, 40.0, 1.25),
            (1366.0, 768.0, 40.0, 1.5),
            (1920.0, 1080.0, 48.0, 1.25),
            (1920.0, 1080.0, 48.0, 1.5),
            (2560.0, 1600.0, 48.0, 1.75),
            (2560.0, 1600.0, 48.0, 2.0),
        ] {
            let fitted = fit_notification_size_to_rect(
                MASCOT_MESSAGE_WIDTH,
                MASCOT_MESSAGE_HEIGHT,
                LogicalSize {
                    width: screen_width / scale,
                    height: (screen_height - taskbar_height) / scale,
                },
            );

            assert_eq!(fitted.width, MASCOT_MESSAGE_WIDTH);
            assert_eq!(fitted.height, MASCOT_MESSAGE_HEIGHT);
        }
    }

    #[test]
    fn every_mascot_layout_uses_the_same_bottom_safety_gutter() {
        for (width, height, visible, compact) in [
            (MASCOT_WIDTH, MASCOT_HEIGHT, false, false),
            (MASCOT_MESSAGE_WIDTH, MASCOT_MESSAGE_HEIGHT, true, true),
            (
                MASCOT_NOTIFICATION_WIDTH,
                MASCOT_NOTIFICATION_HEIGHT,
                true,
                false,
            ),
        ] {
            let offset = mascot_avatar_offset(width, height, visible, compact);
            let bottom_gutter = height - offset.y - MASCOT_AVATAR_HEIGHT;
            assert_eq!(bottom_gutter, MASCOT_NOTIFICATION_BOTTOM_PADDING);
        }
    }

    #[test]
    fn notification_resize_noise_does_not_move_the_restored_mascot() {
        let delta = notification_drag_delta(
            Some(LogicalPosition { x: 500.8, y: 419.2 }),
            LogicalPosition { x: 500.0, y: 420.0 },
        );

        assert_eq!(delta, LogicalPosition { x: 0.0, y: 0.0 });
    }

    #[test]
    fn intentional_notification_drag_is_preserved() {
        let delta = notification_drag_delta(
            Some(LogicalPosition { x: 506.0, y: 416.0 }),
            LogicalPosition { x: 500.0, y: 420.0 },
        );

        assert_eq!(delta, LogicalPosition { x: 6.0, y: -4.0 });
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
    animate_window_position(window, motion, start, target, peek, reduced_motion);
}

fn animate_window_position(
    window: tauri::WebviewWindow,
    motion: MascotDockMotion,
    start: LogicalPosition<f64>,
    target: LogicalPosition<f64>,
    peek: bool,
    reduced_motion: bool,
) {
    let animation_token = motion.cancel();

    if reduced_motion {
        let _ = window.set_position(Position::Logical(target));
        return;
    }

    let duration = Duration::from_millis(if peek {
        MASCOT_PEEK_ANIMATION_DURATION_MS
    } else {
        MASCOT_REVEAL_ANIMATION_DURATION_MS
    });

    thread::spawn(move || {
        let started_at = Instant::now();
        loop {
            if motion.0.load(Ordering::SeqCst) != animation_token {
                return;
            }

            let progress = (started_at.elapsed().as_secs_f64() / duration.as_secs_f64()).min(1.0);
            let eased = if peek {
                // Smootherstep keeps the hide motion quiet at both ends.
                progress.powi(3) * (progress * (progress * 6.0 - 15.0) + 10.0)
            } else {
                // A fast, non-overshooting ease-out reads as responsive without
                // making the whole native window wobble against the screen edge.
                1.0 - (1.0 - progress).powi(4)
            };
            let position = LogicalPosition {
                x: start.x + (target.x - start.x) * eased,
                y: start.y + (target.y - start.y) * eased,
            };
            let _ = window.set_position(Position::Logical(position));

            if progress >= 1.0 {
                break;
            }
            thread::sleep(Duration::from_millis(MASCOT_DOCK_ANIMATION_FRAME_MS));
        }

        if motion.0.load(Ordering::SeqCst) == animation_token {
            let _ = window.set_position(Position::Logical(target));
        }
    });
}

fn mascot_avatar_offset(
    width: f64,
    height: f64,
    visible: bool,
    compact: bool,
) -> LogicalPosition<f64> {
    LogicalPosition {
        x: (width - MASCOT_AVATAR_WIDTH) / 2.0,
        y: if !visible {
            (height - MASCOT_AVATAR_HEIGHT) / 2.0
        } else if compact {
            height - MASCOT_NOTIFICATION_BOTTOM_PADDING - MASCOT_AVATAR_HEIGHT
        } else {
            height - MASCOT_NOTIFICATION_BOTTOM_PADDING - MASCOT_AVATAR_HEIGHT
        },
    }
}

fn align_window_to_avatar(
    source_position: LogicalPosition<f64>,
    source_avatar_offset: LogicalPosition<f64>,
    target_avatar_offset: LogicalPosition<f64>,
) -> LogicalPosition<f64> {
    LogicalPosition {
        x: source_position.x + source_avatar_offset.x - target_avatar_offset.x,
        y: source_position.y + source_avatar_offset.y - target_avatar_offset.y,
    }
}

fn notification_drag_delta(
    current_position: Option<LogicalPosition<f64>>,
    expanded_position: LogicalPosition<f64>,
) -> LogicalPosition<f64> {
    let Some(current_position) = current_position else {
        return LogicalPosition { x: 0.0, y: 0.0 };
    };
    let x = current_position.x - expanded_position.x;
    let y = current_position.y - expanded_position.y;

    LogicalPosition {
        x: if x.abs() <= MASCOT_NOTIFICATION_DRAG_EPSILON {
            0.0
        } else {
            x
        },
        y: if y.abs() <= MASCOT_NOTIFICATION_DRAG_EPSILON {
            0.0
        } else {
            y
        },
    }
}

fn target_outer_dimension(
    logical_inner_size: f64,
    scale: f64,
    current_outer_size: u32,
    current_inner_size: u32,
) -> i32 {
    let frame_size = current_outer_size.saturating_sub(current_inner_size) as i64;
    let target_inner_size = (logical_inner_size * scale).round() as i64;
    (target_inner_size + frame_size).clamp(1, i32::MAX as i64) as i32
}

fn set_window_bounds(
    window: &tauri::WebviewWindow,
    position: Option<LogicalPosition<f64>>,
    width: f64,
    height: f64,
) {
    #[cfg(windows)]
    if let (Some(position), Ok(hwnd)) = (position, window.hwnd()) {
        use windows_sys::Win32::UI::WindowsAndMessaging::{
            SetWindowPos, SWP_NOACTIVATE, SWP_NOOWNERZORDER, SWP_NOZORDER,
        };

        let scale = window.scale_factor().unwrap_or(1.0);
        let current_outer_size = window.outer_size().ok();
        let current_inner_size = window.inner_size().ok();
        let outer_width = current_outer_size
            .zip(current_inner_size)
            .map(|(outer, inner)| target_outer_dimension(width, scale, outer.width, inner.width))
            .unwrap_or_else(|| (width * scale).round() as i32);
        let outer_height = current_outer_size
            .zip(current_inner_size)
            .map(|(outer, inner)| target_outer_dimension(height, scale, outer.height, inner.height))
            .unwrap_or_else(|| (height * scale).round() as i32);
        let updated = unsafe {
            SetWindowPos(
                hwnd.0,
                std::ptr::null_mut(),
                (position.x * scale).round() as i32,
                (position.y * scale).round() as i32,
                outer_width,
                outer_height,
                SWP_NOACTIVATE | SWP_NOOWNERZORDER | SWP_NOZORDER,
            )
        };
        if updated != 0 {
            return;
        }
    }

    let _ = window.set_size(Size::Logical(LogicalSize { width, height }));
    if let Some(position) = position {
        let _ = window.set_position(Position::Logical(position));
    }
}

fn resize_mascot_for_notification(
    window: &tauri::WebviewWindow,
    motion: &MascotDockMotion,
    layout_state: &MascotNotificationLayoutState,
    visible: bool,
    compact: bool,
    reveal: bool,
    reduced_motion: bool,
) {
    let (requested_width, requested_height) = if !visible {
        (MASCOT_WIDTH, MASCOT_HEIGHT)
    } else if compact {
        (MASCOT_MESSAGE_WIDTH, MASCOT_MESSAGE_HEIGHT)
    } else {
        (MASCOT_NOTIFICATION_WIDTH, MASCOT_NOTIFICATION_HEIGHT)
    };
    let target_size = if visible {
        fit_notification_size_to_work_area(window, requested_width, requested_height)
    } else {
        LogicalSize {
            width: requested_width,
            height: requested_height,
        }
    };
    let target_width = target_size.width;
    let target_height = target_size.height;
    let scale = window.scale_factor().unwrap_or(1.0);
    let current_size = window
        .outer_size()
        .ok()
        .map(|size| size.to_logical::<f64>(scale));
    let current_position = window
        .outer_position()
        .ok()
        .map(|position| position.to_logical::<f64>(scale));
    let was_peeked = current_position
        .zip(current_size)
        .and_then(|(position, size)| {
            window.current_monitor().ok().flatten().map(|monitor| {
                let monitor_scale = monitor.scale_factor();
                let work_size = monitor.work_area().size.to_logical::<f64>(monitor_scale);
                let work_pos = monitor
                    .work_area()
                    .position
                    .to_logical::<f64>(monitor_scale);
                peeked_dock_side(
                    position.x,
                    size.width,
                    work_pos.x,
                    work_pos.x + work_size.width,
                )
                .is_some()
            })
        })
        .unwrap_or(false);

    motion.cancel();

    let collapsed_avatar_offset = mascot_avatar_offset(MASCOT_WIDTH, MASCOT_HEIGHT, false, false);
    let target_avatar_offset = mascot_avatar_offset(target_width, target_height, visible, compact);

    let next_position = if visible {
        let requested_restore_position = layout_state
            .0
            .lock()
            .ok()
            .and_then(|layout| layout.as_ref().map(|layout| layout.restore_position))
            .or_else(|| {
                if was_peeked {
                    mascot_dock_target(window, MASCOT_WIDTH, MASCOT_HEIGHT, false)
                } else {
                    current_position
                }
            });

        requested_restore_position.map(|requested_restore_position| {
            let candidate = align_window_to_avatar(
                requested_restore_position,
                collapsed_avatar_offset,
                target_avatar_offset,
            );
            let expanded_position =
                clamp_position_to_work_area(window, candidate, target_width, target_height);
            // If the large card had to be clamped at a monitor edge, the avatar
            // itself moved with it. Restore the small window around the avatar's
            // actual on-screen position instead of snapping back to the old one.
            let restore_position = align_window_to_avatar(
                expanded_position,
                target_avatar_offset,
                collapsed_avatar_offset,
            );
            if let Ok(mut layout) = layout_state.0.lock() {
                *layout = Some(MascotNotificationLayout {
                    restore_position,
                    expanded_position,
                });
            }
            expanded_position
        })
    } else {
        let saved_layout = layout_state
            .0
            .lock()
            .ok()
            .and_then(|mut layout| layout.take());
        saved_layout
            .map(|layout| {
                let drag_delta =
                    notification_drag_delta(current_position, layout.expanded_position);
                clamp_position_to_work_area(
                    window,
                    LogicalPosition {
                        x: layout.restore_position.x + drag_delta.x,
                        y: layout.restore_position.y + drag_delta.y,
                    },
                    MASCOT_WIDTH,
                    MASCOT_HEIGHT,
                )
            })
            .or_else(|| {
                current_position.zip(current_size).map(|(position, size)| {
                    let current_compact = size.width <= MASCOT_MESSAGE_WIDTH + 1.0
                        && size.height <= MASCOT_MESSAGE_HEIGHT + 1.0
                        && size.width > MASCOT_WIDTH + 1.0;
                    let current_visible =
                        size.width > MASCOT_WIDTH + 1.0 || size.height > MASCOT_HEIGHT + 1.0;
                    let current_avatar_offset = mascot_avatar_offset(
                        size.width,
                        size.height,
                        current_visible,
                        current_compact,
                    );
                    clamp_position_to_work_area(
                        window,
                        align_window_to_avatar(
                            position,
                            current_avatar_offset,
                            collapsed_avatar_offset,
                        ),
                        MASCOT_WIDTH,
                        MASCOT_HEIGHT,
                    )
                })
            })
    };

    if visible && reveal && was_peeked {
        let _ = window.set_size(Size::Logical(LogicalSize {
            width: target_width,
            height: target_height,
        }));
        if let Some(position) = next_position {
            let _ = window.show();
            animate_window_position(
                window.clone(),
                motion.clone(),
                current_position.unwrap_or(position),
                position,
                false,
                reduced_motion,
            );
        }
    } else {
        // Updating position and size separately exposes an intermediate WebView
        // frame where the avatar is laid out against the wrong bounds. Windows
        // applies both values atomically here, so dismissing a card cannot make
        // the avatar flash at the expanded window's top-left corner.
        set_window_bounds(window, next_position, target_width, target_height);
    }
}

fn fit_panel_height_to_rect(requested_height: f64, work_height: f64) -> f64 {
    let requested_height = if requested_height.is_finite() {
        requested_height
    } else {
        PANEL_COMPACT_HEIGHT
    };
    let available_height = (work_height - SCREEN_MARGIN * 2.0).max(PANEL_COMPACT_HEIGHT);
    requested_height
        .clamp(PANEL_COMPACT_HEIGHT, PANEL_MAX_HEIGHT)
        .min(available_height)
}

fn fit_panel_height_to_work_area(window: &tauri::WebviewWindow, requested_height: f64) -> f64 {
    let Ok(Some(monitor)) = window.current_monitor() else {
        return fit_panel_height_to_rect(requested_height, f64::INFINITY);
    };
    let scale = monitor.scale_factor();
    let work_height = monitor.work_area().size.to_logical::<f64>(scale).height;
    fit_panel_height_to_rect(requested_height, work_height)
}

fn current_panel_height(panel: &tauri::WebviewWindow) -> f64 {
    let scale = panel.scale_factor().unwrap_or(1.0);
    panel
        .outer_size()
        .ok()
        .map(|size| size.to_logical::<f64>(scale).height)
        .unwrap_or(PANEL_COMPACT_HEIGHT)
        .clamp(PANEL_COMPACT_HEIGHT, PANEL_MAX_HEIGHT)
}

fn place_panel_near_mascot(
    panel: &tauri::WebviewWindow,
    mascot: &tauri::WebviewWindow,
    requested_height: f64,
) {
    let height = fit_panel_height_to_work_area(mascot, requested_height);
    if let Some(position) = panel_position_near_mascot(mascot, height) {
        // Resize and reposition in one Windows compositor operation so wrapped
        // text never spends a frame inside the previous, shorter WebView.
        set_window_bounds(panel, Some(position), PANEL_WIDTH, height);
        return;
    }

    place_bottom_right(panel, PANEL_WIDTH, height);
}

fn panel_position_near_mascot(
    mascot: &tauri::WebviewWindow,
    height: f64,
) -> Option<LogicalPosition<f64>> {
    let mascot_pos = mascot.outer_position().ok()?;
    let scale = mascot.scale_factor().unwrap_or(1.0);
    let mascot_pos = mascot_pos.to_logical::<f64>(scale);
    let (mascot_width, _mascot_height) = mascot_logical_size(mascot);
    let (min_x, max_x, min_y, max_y) = if let Ok(Some(monitor)) = mascot.current_monitor() {
        let screen_size = monitor.work_area().size.to_logical::<f64>(scale);
        let screen_pos = monitor.work_area().position.to_logical::<f64>(scale);
        (
            screen_pos.x + SCREEN_MARGIN,
            screen_pos.x + screen_size.width - PANEL_WIDTH - SCREEN_MARGIN,
            screen_pos.y + SCREEN_MARGIN,
            screen_pos.y + screen_size.height - height - SCREEN_MARGIN,
        )
    } else {
        (SCREEN_MARGIN, f64::MAX, SCREEN_MARGIN, f64::MAX)
    };
    let raw_x = mascot_pos.x + (mascot_width - PANEL_WIDTH) / 2.0;
    let x = raw_x.clamp(min_x, max_x.max(min_x));
    let raw_y = mascot_pos.y - height + PANEL_GAP;
    let y = raw_y.clamp(min_y, max_y.max(min_y));
    Some(LogicalPosition { x, y })
}

#[cfg(windows)]
fn sync_visible_panel_to_mascot(app: &tauri::AppHandle) {
    let (Some(panel), Some(mascot)) = (
        app.get_webview_window("panel"),
        app.get_webview_window("mascot"),
    ) else {
        return;
    };
    if !matches!(panel.is_visible(), Ok(true)) {
        return;
    }
    if let Some(position) = panel_position_near_mascot(&mascot, current_panel_height(&panel)) {
        let _ = panel.set_position(Position::Logical(position));
    }
}

fn emit_panel_visibility(app: &tauri::AppHandle, visible: bool) {
    let _ = app.emit_to("mascot", PANEL_VISIBILITY_EVENT, visible);
}

fn hide_panel_and_notify(app: &tauri::AppHandle) {
    if let Some(panel) = app.get_webview_window("panel") {
        let _ = panel.hide();
    }
    emit_panel_visibility(app, false);
}

fn hide_panel_after_focus_moves_outside_app(app: tauri::AppHandle) {
    thread::spawn(move || {
        // Focus settles after the mouse-down that moves it to another native
        // window. Keep the panel open when focus moved to the mascot itself;
        // that click will deliberately toggle or drag both windows.
        thread::sleep(Duration::from_millis(50));
        let mascot_is_focused = app
            .get_webview_window("mascot")
            .and_then(|window| window.is_focused().ok())
            .unwrap_or(false);
        if mascot_is_focused {
            return;
        }

        if let Some(panel) = app.get_webview_window("panel") {
            if matches!(panel.is_visible(), Ok(true)) {
                let _ = panel.hide();
                emit_panel_visibility(&app, false);
            }
        }
    });
}

#[tauri::command]
fn hide_main_window(app: tauri::AppHandle) {
    if let Some(window) = app.get_webview_window("mascot") {
        let _ = window.hide();
    }
    hide_panel_and_notify(&app);
}

#[tauri::command]
fn show_main_window(
    app: tauri::AppHandle,
    motion: tauri::State<'_, MascotDockMotion>,
    initial_placement: tauri::State<'_, InitialMascotPlacement>,
) {
    if let Some(window) = app.get_webview_window("mascot") {
        ensure_initial_mascot_placement(&window, initial_placement.inner());
        let (width, height) = mascot_logical_size(&window);
        restore_mascot_if_peeked(&window, motion.inner(), width, height);
        let _ = window.show();
        let _ = window.set_focus();
    }
}

#[tauri::command]
fn show_notification_window(
    app: tauri::AppHandle,
    initial_placement: tauri::State<'_, InitialMascotPlacement>,
) {
    if let Some(window) = app.get_webview_window("mascot") {
        // A reminder should become visible without stealing focus from the
        // document or business application the user is working in.
        ensure_initial_mascot_placement(&window, initial_placement.inner());
        let _ = window.show();
    }
}

#[tauri::command]
fn peek_mascot_window(
    app: tauri::AppHandle,
    motion: tauri::State<'_, MascotDockMotion>,
    panel_activity: tauri::State<'_, PanelActivityState>,
    reduced_motion: bool,
) -> Option<String> {
    if let Some(window) = app.get_webview_window("mascot") {
        let (width, height) = mascot_logical_size(&window);
        // Expanded reminders and menus must remain fully visible until handled.
        if width > MASCOT_WIDTH + 1.0 || height > MASCOT_HEIGHT + 1.0 {
            return None;
        }
        if let Some(panel) = app.get_webview_window("panel") {
            if matches!(panel.is_visible(), Ok(true)) && panel_activity.is_engaged() {
                return None;
            }
        }
        let side = current_mascot_dock_side(&window, width)?;
        hide_panel_and_notify(&app);
        animate_mascot_dock(
            window,
            motion.inner().clone(),
            MASCOT_WIDTH,
            MASCOT_HEIGHT,
            true,
            reduced_motion,
        );
        return Some(side.as_str().to_string());
    }

    None
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
    #[cfg(windows)]
    monitor_native_drag(app.clone(), monitor.inner().clone(), token);
    #[cfg(not(windows))]
    let _ = (&app, token);

    window.start_dragging().map_err(|error| error.to_string())?;

    Ok(())
}

#[tauri::command]
fn toggle_panel_window(app: tauri::AppHandle, motion: tauri::State<'_, MascotDockMotion>) -> bool {
    if let (Some(panel), Some(mascot)) = (
        app.get_webview_window("panel"),
        app.get_webview_window("mascot"),
    ) {
        if matches!(panel.is_visible(), Ok(true)) {
            let _ = panel.hide();
            emit_panel_visibility(&app, false);
            return false;
        } else {
            let (width, height) = mascot_logical_size(&mascot);
            restore_mascot_if_peeked(&mascot, motion.inner(), width, height);
            place_panel_near_mascot(&panel, &mascot, current_panel_height(&panel));
            let _ = panel.show();
            let _ = panel.set_focus();
            emit_panel_visibility(&app, true);
            return true;
        }
    }

    false
}

#[tauri::command]
fn show_panel_window(app: tauri::AppHandle, motion: tauri::State<'_, MascotDockMotion>) {
    if let (Some(panel), Some(mascot)) = (
        app.get_webview_window("panel"),
        app.get_webview_window("mascot"),
    ) {
        let (width, height) = mascot_logical_size(&mascot);
        restore_mascot_if_peeked(&mascot, motion.inner(), width, height);
        // Task pushes use this command as their reminder surface. If the user
        // explicitly hid the assistant, a new task should bring the mascot and
        // its panel back without requiring a tray-menu action.
        let _ = mascot.show();
        place_panel_near_mascot(&panel, &mascot, current_panel_height(&panel));
        let _ = panel.show();
        let _ = panel.set_focus();
        emit_panel_visibility(&app, true);
    }
}

#[tauri::command]
fn hide_panel_window(app: tauri::AppHandle) {
    hide_panel_and_notify(&app);
}

#[tauri::command]
fn sync_panel_window(app: tauri::AppHandle) {
    sync_panel_if_visible(&app);
}

#[tauri::command]
fn set_mascot_notification_visible(
    app: tauri::AppHandle,
    motion: tauri::State<'_, MascotDockMotion>,
    layout_state: tauri::State<'_, MascotNotificationLayoutState>,
    initial_placement: tauri::State<'_, InitialMascotPlacement>,
    visible: bool,
    compact: Option<bool>,
    reveal: Option<bool>,
    reduced_motion: Option<bool>,
) {
    if let Some(window) = app.get_webview_window("mascot") {
        // The first frontend layout request can race the hidden window's native
        // setup on Windows. Anchor the collapsed mascot before calculating the
        // expanded login/reminder bounds so no stale top-left restore position
        // can pull the card back or leave it clipped to a thin border.
        ensure_initial_mascot_placement(&window, initial_placement.inner());
        let compact = compact.unwrap_or(false);
        resize_mascot_for_notification(
            &window,
            motion.inner(),
            layout_state.inner(),
            visible,
            compact,
            reveal.unwrap_or(false),
            reduced_motion.unwrap_or(false),
        );
    }
}

#[tauri::command]
fn set_panel_height(app: tauri::AppHandle, height: f64) {
    if let (Some(panel), Some(mascot)) = (
        app.get_webview_window("panel"),
        app.get_webview_window("mascot"),
    ) {
        place_panel_near_mascot(&panel, &mascot, height);
    }
}

#[tauri::command]
fn set_panel_activity(state: tauri::State<'_, PanelActivityState>, has_text: bool, focused: bool) {
    state.set(has_text, focused);
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
                    let initial_placement = app.state::<InitialMascotPlacement>();
                    ensure_initial_mascot_placement(&window, initial_placement.inner());
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
        .manage(InitialMascotPlacement::default())
        .manage(MascotDockMotion::default())
        .manage(MascotNotificationLayoutState::default())
        .manage(MascotDragMonitor::default())
        .manage(PanelActivityState::default())
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
            set_panel_height,
            set_panel_activity,
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
                let _ = place_mascot_bottom_right(&window);
            }
            if let Some(window) = app.get_webview_window("panel") {
                harden_transparent_window(&window);
                let app_handle = app.handle().clone();
                window.on_window_event(move |event| {
                    if matches!(event, tauri::WindowEvent::Focused(false)) {
                        hide_panel_after_focus_moves_outside_app(app_handle.clone());
                    }
                });
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
                            let initial_placement = app.state::<InitialMascotPlacement>();
                            ensure_initial_mascot_placement(&window, initial_placement.inner());
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
