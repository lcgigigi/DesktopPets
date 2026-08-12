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
use tauri::{
    Emitter, LogicalPosition, LogicalSize, Manager, PhysicalPosition, PhysicalSize, Position, Size,
};

// Keep a transparent safety gutter around the sprite. WebView2 can otherwise
// clip the last physical pixel at 125%/150% Windows display scaling.
const MASCOT_WIDTH: f64 = 120.0;
const MASCOT_HEIGHT: f64 = 104.0;
const MASCOT_AVATAR_WIDTH: f64 = 96.0;
const MASCOT_AVATAR_HEIGHT: f64 = 88.0;
const MASCOT_NOTIFICATION_BOTTOM_PADDING: f64 = 8.0;
// Keep the same amount of the safety window visible when peeking from either
// desktop edge. This leaves a discoverable part of Xiaoli on screen.
const MASCOT_PEEK_VISIBLE_WIDTH: f64 = 68.0;
const MASCOT_PEEK_ANIMATION_DURATION_MS: u64 = 560;
const MASCOT_REVEAL_ANIMATION_DURATION_MS: u64 = 480;
const MASCOT_DOCK_ANIMATION_FRAME_MS: u64 = 12;
// WebView2 can report a fractional logical position after a DPI-aware resize.
// Treat that sub-pixel drift as resize noise instead of a user drag.
const MASCOT_NOTIFICATION_DRAG_EPSILON: f64 = 1.0;
const MASCOT_CONTEXT_MENU_WIDTH: f64 = 192.0;
const MASCOT_CONTEXT_MENU_HEIGHT: f64 = 64.0;
const MASCOT_CONTEXT_MENU_GAP: f64 = 18.0;
const MASCOT_CONTEXT_MENU_ABOVE_VISIBLE_BOTTOM: f64 = 51.0;
const MASCOT_CONTEXT_MENU_BELOW_VISIBLE_TOP: f64 = 7.0;
const MASCOT_CONTEXT_MENU_NAV_LEFT: f64 = 12.0;
const MASCOT_CONTEXT_MENU_TAIL_MIN: f64 = 18.0;
const MASCOT_CONTEXT_MENU_TAIL_MAX: f64 = 150.0;
const DESKTOP_AUTH_CALLBACK_PREFIX: &str = "huali-ai-mascot://auth-callback";
const DESKTOP_AUTH_CALLBACK_FILE: &str = "huali-ai-mascot-auth-callback.tmp";
const PANEL_VISIBILITY_EVENT: &str = "huali:panel-visibility";
const MASCOT_CONTEXT_MENU_VISIBILITY_EVENT: &str = "mascot-context-menu-visibility";

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

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
struct MascotContextMenuStatus {
    ready: bool,
    desired_visible: bool,
    visible: bool,
    generation: u64,
}

#[derive(Clone, Default)]
struct MascotContextMenuState {
    status: Arc<Mutex<MascotContextMenuStatus>>,
    // Serializes native show/hide operations. The generation guards logical
    // intent; this lock prevents a stale show from physically overtaking a
    // newer hide while WebView2 is processing window messages.
    transition: Arc<Mutex<()>>,
}

impl MascotContextMenuState {
    fn request_show(&self) -> u64 {
        let Ok(mut status) = self.status.lock() else {
            return 0;
        };
        status.generation = status.generation.wrapping_add(1);
        status.desired_visible = true;
        // A new show request supersedes the focus state of any older menu
        // generation. Its delayed Focused(false) event must not cancel this
        // newer request while the independent window is being repositioned.
        status.visible = false;
        status.generation
    }

    fn request_hide(&self) -> u64 {
        let Ok(mut status) = self.status.lock() else {
            return 0;
        };
        status.generation = status.generation.wrapping_add(1);
        status.desired_visible = false;
        status.visible = false;
        status.generation
    }

    fn mark_ready(&self) -> Option<u64> {
        let mut status = self.status.lock().ok()?;
        status.ready = true;
        status.desired_visible.then_some(status.generation)
    }

    fn can_show(&self, generation: u64) -> bool {
        self.status
            .lock()
            .map(|status| status.ready && status.desired_visible && status.generation == generation)
            .unwrap_or(false)
    }

    fn mark_visible(&self, generation: u64) -> bool {
        let Ok(mut status) = self.status.lock() else {
            return false;
        };
        if !status.ready || !status.desired_visible || status.generation != generation {
            return false;
        }
        status.visible = true;
        true
    }

    fn is_visible(&self) -> bool {
        self.status
            .lock()
            .map(|status| status.visible)
            .unwrap_or(false)
    }

    #[cfg(test)]
    fn snapshot(&self) -> MascotContextMenuStatus {
        self.status.lock().map(|status| *status).unwrap_or_default()
    }
}

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

#[cfg(any(windows, test))]
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
const MASCOT_MESSAGE_HEIGHT: f64 = 176.0;
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
        mascot_avatar_physical_rect, mascot_bottom_right_position,
        mascot_context_menu_physical_geometry, mascot_dock_x, nearest_dock_side,
        notification_drag_delta, peeked_dock_side, target_outer_dimension, LogicalPosition,
        LogicalSize, MascotContextMenuPlacement, MascotContextMenuState, MascotDockSide,
        PanelActivityState, PhysicalPosition, PhysicalRect, PhysicalSize, MASCOT_AVATAR_HEIGHT,
        MASCOT_AVATAR_WIDTH, MASCOT_CONTEXT_MENU_ABOVE_VISIBLE_BOTTOM,
        MASCOT_CONTEXT_MENU_BELOW_VISIBLE_TOP, MASCOT_CONTEXT_MENU_GAP, MASCOT_CONTEXT_MENU_HEIGHT,
        MASCOT_CONTEXT_MENU_TAIL_MAX, MASCOT_CONTEXT_MENU_TAIL_MIN, MASCOT_CONTEXT_MENU_WIDTH,
        MASCOT_HEIGHT, MASCOT_MESSAGE_HEIGHT, MASCOT_MESSAGE_WIDTH,
        MASCOT_NOTIFICATION_BOTTOM_PADDING, MASCOT_NOTIFICATION_HEIGHT, MASCOT_NOTIFICATION_WIDTH,
        MASCOT_PEEK_VISIBLE_WIDTH, MASCOT_REST_BOTTOM_MARGIN, MASCOT_REST_RIGHT_MARGIN,
        MASCOT_WIDTH, PANEL_COMPACT_HEIGHT, PANEL_MAX_HEIGHT, SCREEN_MARGIN,
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
            (1.0, 240, 176),
            (1.25, 300, 220),
            (1.5, 360, 264),
            (1.75, 420, 308),
            (2.0, 480, 352),
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
    fn context_menu_position_keeps_mascot_window_stationary() {
        let client_origin = PhysicalPosition { x: 1500, y: 700 };
        let avatar = mascot_avatar_physical_rect(
            client_origin,
            PhysicalSize {
                width: MASCOT_WIDTH as u32,
                height: MASCOT_HEIGHT as u32,
            },
            1.0,
        );
        let geometry = mascot_context_menu_physical_geometry(
            avatar,
            PhysicalRect {
                x: 0,
                y: 0,
                width: 1920,
                height: 1040,
            },
            1.0,
        );

        assert_eq!(
            geometry.payload.placement,
            MascotContextMenuPlacement::Above
        );
        assert_eq!(client_origin, PhysicalPosition { x: 1500, y: 700 });
        assert_eq!(
            geometry.position.y + MASCOT_CONTEXT_MENU_ABOVE_VISIBLE_BOTTOM as i32,
            avatar.y - MASCOT_CONTEXT_MENU_GAP as i32
        );
        assert_eq!(
            geometry.position.x + MASCOT_CONTEXT_MENU_WIDTH as i32 / 2,
            avatar.x + avatar.width as i32 / 2
        );
        assert_eq!(geometry.payload.tail_x, 84.0);
    }

    #[test]
    fn context_menu_flips_below_the_mascot_near_the_top_edge() {
        let avatar = PhysicalRect {
            x: 112,
            y: 38,
            width: 96,
            height: 88,
        };
        let geometry = mascot_context_menu_physical_geometry(
            avatar,
            PhysicalRect {
                x: 0,
                y: 0,
                width: 1366,
                height: 728,
            },
            1.0,
        );

        assert_eq!(
            geometry.payload.placement,
            MascotContextMenuPlacement::Below
        );
        assert_eq!(
            geometry.position.y + MASCOT_CONTEXT_MENU_BELOW_VISIBLE_TOP as i32,
            avatar.y + avatar.height as i32 + MASCOT_CONTEXT_MENU_GAP as i32
        );
    }

    #[test]
    fn context_menu_uses_target_monitor_physical_pixels_at_fractional_dpi() {
        for scale in [1.0_f64, 1.25, 1.5, 1.75, 2.0] {
            let work_area = PhysicalRect {
                x: -(1920.0 * scale) as i32,
                y: 0,
                width: (1920.0 * scale) as u32,
                height: (1040.0 * scale) as u32,
            };
            let avatar = PhysicalRect {
                x: work_area.x + (12.0 * scale).round() as i32,
                y: (700.0 * scale).round() as i32,
                width: (MASCOT_AVATAR_WIDTH * scale).round() as u32,
                height: (MASCOT_AVATAR_HEIGHT * scale).round() as u32,
            };
            let geometry = mascot_context_menu_physical_geometry(avatar, work_area, scale);
            let margin = (SCREEN_MARGIN * scale).round() as i32;

            assert_eq!(
                geometry.size.width,
                (MASCOT_CONTEXT_MENU_WIDTH * scale).round() as u32
            );
            assert_eq!(
                geometry.size.height,
                (MASCOT_CONTEXT_MENU_HEIGHT * scale).round() as u32
            );
            assert!(geometry.position.x >= work_area.x + margin);
            assert!(
                geometry.position.x + geometry.size.width as i32
                    <= work_area.x + work_area.width as i32 - margin
            );
            assert!(geometry.payload.tail_x >= MASCOT_CONTEXT_MENU_TAIL_MIN);
            assert!(geometry.payload.tail_x <= MASCOT_CONTEXT_MENU_TAIL_MAX);
        }
    }

    #[test]
    fn context_menu_tail_stays_inside_the_nav_when_window_is_edge_clamped() {
        let work_area = PhysicalRect {
            x: 0,
            y: 0,
            width: 1366,
            height: 728,
        };
        let left = mascot_context_menu_physical_geometry(
            PhysicalRect {
                x: 0,
                y: 400,
                width: MASCOT_AVATAR_WIDTH as u32,
                height: MASCOT_AVATAR_HEIGHT as u32,
            },
            work_area,
            1.0,
        );
        let right = mascot_context_menu_physical_geometry(
            PhysicalRect {
                x: 1366 - MASCOT_AVATAR_WIDTH as i32,
                y: 400,
                width: MASCOT_AVATAR_WIDTH as u32,
                height: MASCOT_AVATAR_HEIGHT as u32,
            },
            work_area,
            1.0,
        );

        assert_eq!(left.payload.tail_x, MASCOT_CONTEXT_MENU_TAIL_MIN);
        assert_eq!(right.payload.tail_x, MASCOT_CONTEXT_MENU_TAIL_MAX);
    }

    #[test]
    fn context_menu_anchor_uses_the_live_expanded_client_size() {
        let avatar = mascot_avatar_physical_rect(
            PhysicalPosition { x: 200, y: 100 },
            PhysicalSize {
                width: 400,
                height: 600,
            },
            1.25,
        );

        assert_eq!(avatar.x, 200 + (112.0_f64 * 1.25).round() as i32);
        assert_eq!(avatar.y, 100 + (384.0_f64 * 1.25).round() as i32);
        assert_eq!(avatar.width, (MASCOT_AVATAR_WIDTH * 1.25).round() as u32);
        assert_eq!(avatar.height, (MASCOT_AVATAR_HEIGHT * 1.25).round() as u32);
    }

    #[test]
    fn context_menu_state_waits_for_webview_ready_and_cancels_stale_show() {
        let state = MascotContextMenuState::default();
        let first_show = state.request_show();
        assert!(!state.can_show(first_show));
        assert_eq!(state.mark_ready(), Some(first_show));
        assert!(state.can_show(first_show));

        state.request_hide();
        assert!(!state.can_show(first_show));
        assert!(!state.snapshot().visible);

        let latest_show = state.request_show();
        assert!(!state.can_show(first_show));
        assert!(state.can_show(latest_show));
        assert!(state.mark_visible(latest_show));
        assert!(state.snapshot().visible);
    }

    #[test]
    fn context_menu_hide_before_ready_prevents_late_first_show() {
        let state = MascotContextMenuState::default();
        let stale_show = state.request_show();
        state.request_hide();

        assert_eq!(state.mark_ready(), None);
        assert!(!state.can_show(stale_show));
        assert!(!state.snapshot().desired_visible);
    }

    #[test]
    fn stale_focus_loss_cannot_cancel_a_new_context_menu_generation() {
        let state = MascotContextMenuState::default();
        let first_show = state.request_show();
        assert_eq!(state.mark_ready(), Some(first_show));
        assert!(state.mark_visible(first_show));
        assert!(state.is_visible());

        let replacement_show = state.request_show();
        assert!(!state.is_visible());
        assert!(state.can_show(replacement_show));
        assert!(!state.can_show(first_show));
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
    _compact: bool,
) -> LogicalPosition<f64> {
    LogicalPosition {
        x: (width - MASCOT_AVATAR_WIDTH) / 2.0,
        y: if visible {
            height - MASCOT_NOTIFICATION_BOTTOM_PADDING - MASCOT_AVATAR_HEIGHT
        } else {
            (height - MASCOT_AVATAR_HEIGHT) / 2.0
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

#[cfg(any(windows, test))]
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

fn set_window_physical_bounds(
    window: &tauri::WebviewWindow,
    position: PhysicalPosition<i32>,
    size: PhysicalSize<u32>,
) {
    #[cfg(windows)]
    if let Ok(hwnd) = window.hwnd() {
        use windows_sys::Win32::UI::WindowsAndMessaging::{
            SetWindowPos, SWP_NOACTIVATE, SWP_NOOWNERZORDER, SWP_NOZORDER,
        };
        let updated = unsafe {
            SetWindowPos(
                hwnd.0,
                std::ptr::null_mut(),
                position.x,
                position.y,
                size.width.min(i32::MAX as u32) as i32,
                size.height.min(i32::MAX as u32) as i32,
                SWP_NOACTIVATE | SWP_NOOWNERZORDER | SWP_NOZORDER,
            )
        };
        if updated != 0 {
            return;
        }
    }

    let _ = window.set_size(Size::Physical(size));
    let _ = window.set_position(Position::Physical(position));
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

#[derive(Clone, Copy, Debug, PartialEq, Eq, serde::Serialize)]
#[serde(rename_all = "lowercase")]
enum MascotContextMenuPlacement {
    Above,
    Below,
}

#[derive(Clone, Copy, Debug, PartialEq, serde::Serialize)]
#[serde(rename_all = "camelCase")]
struct MascotContextMenuPlacementPayload {
    placement: MascotContextMenuPlacement,
    // CSS consumes this as a logical coordinate inside the 168-DIP nav. It is
    // deliberately not relative to the 192-DIP transparent native window.
    tail_x: f64,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
struct PhysicalRect {
    x: i32,
    y: i32,
    width: u32,
    height: u32,
}

#[derive(Clone, Copy, Debug, PartialEq)]
struct MascotContextMenuGeometry {
    position: PhysicalPosition<i32>,
    size: PhysicalSize<u32>,
    payload: MascotContextMenuPlacementPayload,
}

fn logical_to_physical(value: f64, scale: f64) -> i64 {
    (value * scale.max(f64::EPSILON)).round() as i64
}

fn mascot_context_menu_physical_geometry(
    avatar: PhysicalRect,
    work_area: PhysicalRect,
    scale: f64,
) -> MascotContextMenuGeometry {
    let scale = if scale.is_finite() && scale > 0.0 {
        scale
    } else {
        1.0
    };
    let menu_width = logical_to_physical(MASCOT_CONTEXT_MENU_WIDTH, scale).max(1);
    let menu_height = logical_to_physical(MASCOT_CONTEXT_MENU_HEIGHT, scale).max(1);
    let margin = logical_to_physical(SCREEN_MARGIN, scale).max(0);
    let gap = logical_to_physical(MASCOT_CONTEXT_MENU_GAP, scale).max(0);
    let visible_bottom =
        logical_to_physical(MASCOT_CONTEXT_MENU_ABOVE_VISIBLE_BOTTOM, scale).max(0);
    let visible_top = logical_to_physical(MASCOT_CONTEXT_MENU_BELOW_VISIBLE_TOP, scale).max(0);

    let work_left = i64::from(work_area.x);
    let work_top = i64::from(work_area.y);
    let work_right = work_left + i64::from(work_area.width);
    let work_bottom = work_top + i64::from(work_area.height);
    let avatar_left = i64::from(avatar.x);
    let avatar_top = i64::from(avatar.y);
    let avatar_right = avatar_left + i64::from(avatar.width);
    let avatar_bottom = avatar_top + i64::from(avatar.height);
    let avatar_center_x = (avatar_left as f64 + avatar_right as f64) / 2.0;

    let min_x = work_left + margin;
    let max_x = work_right - menu_width - margin;
    let desired_x = (avatar_center_x - menu_width as f64 / 2.0).round() as i64;
    let x = if max_x >= min_x {
        desired_x.clamp(min_x, max_x)
    } else {
        work_left + (i64::from(work_area.width) - menu_width) / 2
    };

    // The outer menu window contains transparent gutters. Align the visible
    // tail edge, not the HWND edge, to the requested gap from the avatar.
    let above_y = avatar_top - gap - visible_bottom;
    let below_y = avatar_bottom + gap - visible_top;
    let min_y = work_top + margin;
    let max_y = work_bottom - menu_height - margin;
    let (y, placement) = if above_y >= min_y {
        (above_y, MascotContextMenuPlacement::Above)
    } else {
        (
            if max_y >= min_y {
                below_y.clamp(min_y, max_y)
            } else {
                work_top + (i64::from(work_area.height) - menu_height) / 2
            },
            MascotContextMenuPlacement::Below,
        )
    };

    let nav_left_physical = x as f64 + MASCOT_CONTEXT_MENU_NAV_LEFT * scale;
    let tail_x = ((avatar_center_x - nav_left_physical) / scale)
        .clamp(MASCOT_CONTEXT_MENU_TAIL_MIN, MASCOT_CONTEXT_MENU_TAIL_MAX);

    MascotContextMenuGeometry {
        position: PhysicalPosition {
            x: x.clamp(i64::from(i32::MIN), i64::from(i32::MAX)) as i32,
            y: y.clamp(i64::from(i32::MIN), i64::from(i32::MAX)) as i32,
        },
        size: PhysicalSize {
            width: menu_width.min(i64::from(u32::MAX)) as u32,
            height: menu_height.min(i64::from(u32::MAX)) as u32,
        },
        payload: MascotContextMenuPlacementPayload { placement, tail_x },
    }
}

fn mascot_client_origin_physical(mascot: &tauri::WebviewWindow) -> Option<PhysicalPosition<i32>> {
    #[cfg(windows)]
    {
        use windows_sys::Win32::Foundation::POINT;
        use windows_sys::Win32::Graphics::Gdi::ClientToScreen;

        let hwnd = mascot.hwnd().ok()?;
        let mut point = POINT { x: 0, y: 0 };
        if unsafe { ClientToScreen(hwnd.0, &mut point) } != 0 {
            return Some(PhysicalPosition {
                x: point.x,
                y: point.y,
            });
        }
    }

    mascot.outer_position().ok()
}

fn mascot_avatar_physical_rect(
    client_origin: PhysicalPosition<i32>,
    client_size: PhysicalSize<u32>,
    scale: f64,
) -> PhysicalRect {
    let scale = if scale.is_finite() && scale > 0.0 {
        scale
    } else {
        1.0
    };
    let logical_size = client_size.to_logical::<f64>(scale);
    let visible =
        logical_size.width > MASCOT_WIDTH + 1.0 || logical_size.height > MASCOT_HEIGHT + 1.0;
    let compact = visible
        && logical_size.width <= MASCOT_MESSAGE_WIDTH + 1.0
        && logical_size.height <= MASCOT_MESSAGE_HEIGHT + 1.0;
    let offset = mascot_avatar_offset(logical_size.width, logical_size.height, visible, compact);

    PhysicalRect {
        x: (i64::from(client_origin.x) + logical_to_physical(offset.x, scale))
            .clamp(i64::from(i32::MIN), i64::from(i32::MAX)) as i32,
        y: (i64::from(client_origin.y) + logical_to_physical(offset.y, scale))
            .clamp(i64::from(i32::MIN), i64::from(i32::MAX)) as i32,
        width: logical_to_physical(MASCOT_AVATAR_WIDTH, scale).clamp(1, i64::from(u32::MAX)) as u32,
        height: logical_to_physical(MASCOT_AVATAR_HEIGHT, scale).clamp(1, i64::from(u32::MAX))
            as u32,
    }
}

fn emit_mascot_context_menu_visibility(app: &tauri::AppHandle, visible: bool) {
    let _ = app.emit_to("mascot", MASCOT_CONTEXT_MENU_VISIBILITY_EVENT, visible);
}

fn hide_mascot_context_menu_window(app: &tauri::AppHandle) {
    let state = app.state::<MascotContextMenuState>();
    state.request_hide();
    let Ok(_transition) = state.transition.lock() else {
        return;
    };
    if let Some(menu) = app.get_webview_window("mascot-menu") {
        let _ = menu.hide();
    }
    emit_mascot_context_menu_visibility(app, false);
}

fn show_mascot_context_menu_generation(
    app: &tauri::AppHandle,
    state: &MascotContextMenuState,
    generation: u64,
) {
    let Ok(_transition) = state.transition.lock() else {
        return;
    };
    if !state.can_show(generation) {
        return;
    }

    let (Some(mascot), Some(menu)) = (
        app.get_webview_window("mascot"),
        app.get_webview_window("mascot-menu"),
    ) else {
        return;
    };
    let scale = mascot.scale_factor().unwrap_or(1.0);
    let Some(client_origin) = mascot_client_origin_physical(&mascot) else {
        return;
    };
    let client_size = mascot.inner_size().unwrap_or(PhysicalSize {
        width: logical_to_physical(MASCOT_WIDTH, scale).max(1) as u32,
        height: logical_to_physical(MASCOT_HEIGHT, scale).max(1) as u32,
    });
    let avatar = mascot_avatar_physical_rect(client_origin, client_size, scale);
    let avatar_center_x = i64::from(avatar.x) + i64::from(avatar.width) / 2;
    let avatar_center_y = i64::from(avatar.y) + i64::from(avatar.height) / 2;
    // An expanded transparent mascot window can span displays. Select the
    // monitor containing the actual avatar rather than the HWND's majority
    // area, otherwise a mixed-DPI boundary can apply the wrong work area and
    // scale to the independent menu window.
    let monitor = mascot
        .available_monitors()
        .ok()
        .and_then(|monitors| {
            monitors.into_iter().find(|monitor| {
                let position = monitor.position();
                let size = monitor.size();
                let left = i64::from(position.x);
                let top = i64::from(position.y);
                avatar_center_x >= left
                    && avatar_center_x < left + i64::from(size.width)
                    && avatar_center_y >= top
                    && avatar_center_y < top + i64::from(size.height)
            })
        })
        .or_else(|| mascot.current_monitor().ok().flatten())
        .or_else(|| mascot.primary_monitor().ok().flatten());
    let Some(monitor) = monitor else {
        return;
    };
    let work_area = monitor.work_area();
    let geometry = mascot_context_menu_physical_geometry(
        avatar,
        PhysicalRect {
            x: work_area.position.x,
            y: work_area.position.y,
            width: work_area.size.width,
            height: work_area.size.height,
        },
        monitor.scale_factor(),
    );

    harden_transparent_window(&menu);
    set_window_physical_bounds(&menu, geometry.position, geometry.size);
    let _ = app.emit_to(
        "mascot-menu",
        "mascot-context-menu-placement",
        geometry.payload,
    );
    if !state.can_show(generation) {
        return;
    }

    if menu.show().is_err() || !state.can_show(generation) || menu.set_focus().is_err() {
        let _ = menu.hide();
        emit_mascot_context_menu_visibility(app, false);
        return;
    }
    if !state.mark_visible(generation) {
        let _ = menu.hide();
        emit_mascot_context_menu_visibility(app, false);
        return;
    }
    emit_mascot_context_menu_visibility(app, true);
}

#[tauri::command]
fn show_mascot_context_menu(
    app: tauri::AppHandle,
    state: tauri::State<'_, MascotContextMenuState>,
) {
    hide_panel_and_notify(&app);
    let generation = state.request_show();
    if state.can_show(generation) {
        show_mascot_context_menu_generation(&app, state.inner(), generation);
    }
}

#[tauri::command]
fn hide_mascot_context_menu(app: tauri::AppHandle) {
    hide_mascot_context_menu_window(&app);
}

#[tauri::command]
fn set_mascot_context_menu_ready(
    app: tauri::AppHandle,
    state: tauri::State<'_, MascotContextMenuState>,
) {
    if let Some(generation) = state.mark_ready() {
        show_mascot_context_menu_generation(&app, state.inner(), generation);
    }
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
    hide_mascot_context_menu_window(&app);
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
    hide_mascot_context_menu_window(&app);
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
    hide_mascot_context_menu_window(&app);
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
    hide_mascot_context_menu_window(&app);
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
    hide_mascot_context_menu_window(&app);
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
    hide_mascot_context_menu_window(&app);
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
    hide_mascot_context_menu_window(&app);
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
    hide_mascot_context_menu_window(&app);
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
#[allow(clippy::too_many_arguments)]
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
    if visible {
        hide_mascot_context_menu_window(&app);
    }
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
        .manage(MascotContextMenuState::default())
        .manage(MascotDragMonitor::default())
        .manage(PanelActivityState::default())
        .invoke_handler(tauri::generate_handler![
            hide_main_window,
            show_mascot_context_menu,
            hide_mascot_context_menu,
            set_mascot_context_menu_ready,
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
            if let Some(window) = app.get_webview_window("mascot-menu") {
                harden_transparent_window(&window);
                let app_handle = app.handle().clone();
                window.on_window_event(move |event| {
                    if matches!(event, tauri::WindowEvent::Focused(false))
                        && app_handle.state::<MascotContextMenuState>().is_visible()
                    {
                        hide_mascot_context_menu_window(&app_handle);
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
                        hide_mascot_context_menu_window(app);
                        let _ = app.emit("tray-open-workbench", ());
                    }
                    "show" => {
                        hide_mascot_context_menu_window(app);
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
                        hide_mascot_context_menu_window(app);
                        if let Some(window) = app.get_webview_window("mascot") {
                            let _ = window.hide();
                        }
                        if let Some(window) = app.get_webview_window("panel") {
                            let _ = window.hide();
                        }
                    }
                    "logout" => {
                        hide_mascot_context_menu_window(app);
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
