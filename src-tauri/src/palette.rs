//! The palette window — port of `src/main/palette-window.ts`.
//!
//! A frameless, always-on-top window that lives hidden for the whole session
//! and is shown on a module's hotkey. The hard-won platform behaviour of the
//! Electron build carries over:
//!
//!  - Focus: remember the window that was focused before showing, restore it
//!    on Escape — unless it moved to another virtual desktop, in which case
//!    hand focus to whatever is on top of the current one.
//!  - Windows foreground lock: `SetForegroundWindow` from a background process
//!    is routinely refused, so the palette is forced forward through
//!    `runwa-core`'s AttachThreadInput path, and a blur within 250 ms of
//!    showing (a remapper's injected key-ups landing on the previous app) is
//!    answered by re-grabbing focus instead of dismissing.
//!  - Windows virtual desktops: a hidden window stays on the desktop it was
//!    last shown on, and showing it again would reveal it there — invisibly.
//!    The window is rebuilt when that happens, as in the Electron build.
//!  - macOS Spaces: the window joins all Spaces, re-asserted on every open.
//!  - Size: only a user resize is persisted; sizes the OS imposes (a display
//!    change across sleep, DPI rounding) are not.
//!
//! Not ported yet: macOS non-activating NSPanel (Electron's `type: 'panel'`)
//! and the opacity-0 reveal that hides a stale frame. See
//! docs/tauri-migration.md.

use std::sync::atomic::{AtomicU64, Ordering};
use std::time::{Duration, Instant};

use parking_lot::Mutex;
use tauri::{
    AppHandle, Emitter, LogicalPosition, LogicalSize, Manager, PhysicalPosition, PhysicalSize,
    WebviewUrl, WebviewWindow, WebviewWindowBuilder, WindowEvent,
};

use crate::app::AppState;
use crate::settings::Settings;
use crate::types::{PaletteShowPayload, SecondPress};

pub const LABEL_PREFIX: &str = "palette";

const DEFAULT_WIDTH: f64 = 720.0;
const DEFAULT_HEIGHT: f64 = 520.0;
const MIN_WIDTH: f64 = 480.0;
const MIN_HEIGHT: f64 = 320.0;
const MIN_VISIBLE_INTERSECTION_WIDTH: f64 = 80.0;
const MIN_VISIBLE_INTERSECTION_HEIGHT: f64 = 60.0;

/// Window after `show()` during which a blur is treated as spurious — an
/// injected hotkey's key-ups (AutoHotkey, PowerToys Keyboard Manager)
/// handing focus back to the previous app before the user saw anything. A
/// human can't meaningfully click away in under ~300 ms.
#[cfg_attr(not(target_os = "windows"), allow(dead_code))]
const BLUR_GRACE: Duration = Duration::from_millis(250);

/// Resize events this soon after we sized the window ourselves are ours.
const PROGRAMMATIC_RESIZE_WINDOW: Duration = Duration::from_millis(600);
/// Debounce before a user resize is written to settings.
const RESIZE_PERSIST_DELAY: Duration = Duration::from_millis(300);
/// Below this, a size difference is DPI rounding rather than a resize.
const DPI_ROUNDING_SLOP: f64 = 2.0;

/// True for the palette window, whatever generation it is.
pub fn is_palette_label(label: &str) -> bool {
    label == LABEL_PREFIX || label.starts_with("palette-")
}

#[derive(Default)]
struct State {
    /// Label of the live palette window (it changes when the window is
    /// rebuilt, since a label can't be reused until the old one is gone).
    label: Option<String>,
    generation: u32,
    /// Set once the renderer of the current window has subscribed to
    /// `palette:show`; until then a show is parked in `pending_show`.
    renderer_listening: bool,
    pending_show: Option<PaletteShowPayload>,
    previous_window_id: Option<String>,
    last_shown_at: Option<Instant>,
    current_module_id: Option<String>,
    /// Logical top-left and scale factor captured when a drag starts.
    move_start: Option<(f64, f64, f64)>,
    last_programmatic_resize: Option<Instant>,
}

#[derive(Default)]
pub struct PaletteController {
    state: Mutex<State>,
    resize_generation: AtomicU64,
}

fn controller(app: &AppHandle) -> tauri::State<'_, AppState> {
    app.state::<AppState>()
}

/// The live palette window, if any.
pub fn window(app: &AppHandle) -> Option<WebviewWindow> {
    let label = controller(app).palette.state.lock().label.clone()?;
    app.get_webview_window(&label)
}

#[cfg(target_os = "windows")]
fn hwnd_of(window: &WebviewWindow) -> Option<String> {
    window.hwnd().ok().map(|hwnd| (hwnd.0 as usize).to_string())
}

#[cfg(not(target_os = "windows"))]
fn hwnd_of(_window: &WebviewWindow) -> Option<String> {
    None
}

/// Create the palette window, hidden. Idempotent.
pub fn create(app: &AppHandle) -> tauri::Result<WebviewWindow> {
    if let Some(existing) = window(app) {
        return Ok(existing);
    }
    let state = controller(app);
    let settings = state.settings.get();
    let (width, height) = saved_size(&settings);

    let label = {
        let mut palette = state.palette.state.lock();
        palette.generation += 1;
        let label = if palette.generation == 1 {
            LABEL_PREFIX.to_owned()
        } else {
            format!("{LABEL_PREFIX}-{}", palette.generation)
        };
        palette.label = Some(label.clone());
        palette.renderer_listening = false;
        label
    };
    log::info!("[palette] create: building window {label}");

    let builder =
        WebviewWindowBuilder::new(app, &label, WebviewUrl::App("index.html#palette".into()))
            .title(&state.paths.app_name)
            .inner_size(width, height)
            .min_inner_size(MIN_WIDTH, MIN_HEIGHT)
            .decorations(false)
            .resizable(true)
            .maximizable(false)
            .minimizable(false)
            .skip_taskbar(true)
            .always_on_top(true)
            .visible(false)
            .focused(false);

    // Spaces affinity: a window is anchored to the Space it was created on,
    // so showing it from another Space would swap the user back. Joining
    // all Spaces makes it follow the active one, like Spotlight / Raycast.
    #[cfg(target_os = "macos")]
    let builder = builder.visible_on_all_workspaces(true);

    builder.build()
}

fn saved_size(settings: &Settings) -> (f64, f64) {
    let (width, height) = settings
        .palette_size()
        .unwrap_or((DEFAULT_WIDTH, DEFAULT_HEIGHT));
    (width.max(MIN_WIDTH), height.max(MIN_HEIGHT))
}

/// Where to open, in logical pixels, plus the scale factor of the monitor
/// that position is on.
struct Placement {
    x: f64,
    y: f64,
    width: f64,
    height: f64,
    scale: f64,
}

fn resolve_placement(app: &AppHandle, settings: &Settings) -> Option<Placement> {
    let (width, height) = saved_size(settings);
    let monitors = app.available_monitors().unwrap_or_default();

    // The last dragged position, if enough of the palette would still be
    // visible on some monitor's work area.
    if let Some((x, y)) = settings.palette_position() {
        for monitor in &monitors {
            let scale = monitor.scale_factor();
            let area = monitor.work_area();
            let (ax, ay) = (
                area.position.x as f64 / scale,
                area.position.y as f64 / scale,
            );
            let (aw, ah) = (
                area.size.width as f64 / scale,
                area.size.height as f64 / scale,
            );
            let visible_w = (x + width).min(ax + aw) - x.max(ax);
            let visible_h = (y + height).min(ay + ah) - y.max(ay);
            if visible_w >= MIN_VISIBLE_INTERSECTION_WIDTH
                && visible_h >= MIN_VISIBLE_INTERSECTION_HEIGHT
            {
                return Some(Placement {
                    x,
                    y,
                    width,
                    height,
                    scale,
                });
            }
        }
    }

    // Otherwise centred on the monitor under the pointer, upper third —
    // where launchers feel natural.
    let monitor = app
        .cursor_position()
        .ok()
        .and_then(|cursor| app.monitor_from_point(cursor.x, cursor.y).ok().flatten())
        .or_else(|| app.primary_monitor().ok().flatten())
        .or_else(|| monitors.into_iter().next())?;
    let scale = monitor.scale_factor();
    let area = monitor.work_area();
    let (ax, ay) = (
        area.position.x as f64 / scale,
        area.position.y as f64 / scale,
    );
    let (aw, ah) = (
        area.size.width as f64 / scale,
        area.size.height as f64 / scale,
    );
    Some(Placement {
        x: (ax + (aw - width) / 2.0).round(),
        y: (ay + ah * 0.28).round(),
        width,
        height,
        scale,
    })
}

/// Apply logical bounds. macOS positions windows in points on one global
/// plane, so logical coordinates go straight through; Windows and Linux
/// position in physical pixels, converted with the target monitor's scale
/// rather than whatever monitor the hidden window last sat on.
fn apply_bounds(window: &WebviewWindow, x: f64, y: f64, width: f64, height: f64, scale: f64) {
    if cfg!(target_os = "macos") {
        let _ = window.set_position(LogicalPosition::new(x, y));
        let _ = window.set_size(LogicalSize::new(width, height));
    } else {
        let _ = window.set_position(PhysicalPosition::new(
            (x * scale).round() as i32,
            (y * scale).round() as i32,
        ));
        let _ = window.set_size(PhysicalSize::new(
            (width * scale).round() as u32,
            (height * scale).round() as u32,
        ));
    }
}

pub fn show(app: &AppHandle, module_id: &str) {
    let state = controller(app);

    // Windows virtual-desktop affinity: rebuild a window that is stuck on
    // another desktop. The renderer is a plain Vite bundle — cheap to boot.
    #[cfg(target_os = "windows")]
    if let Some(existing) = window(app) {
        if let Some(hwnd) = hwnd_of(&existing) {
            let on_current = runwa_core::is_window_on_current_desktop(&hwnd).unwrap_or(true);
            if !on_current {
                log::info!("[palette] show: destroying palette stuck on another desktop");
                let _ = existing.destroy();
                state.palette.state.lock().label = None;
            }
        }
    }

    let win = match create(app) {
        Ok(win) => win,
        Err(err) => {
            log::error!("[palette] cannot create the palette window: {err}");
            return;
        }
    };

    // Remember which window had focus, for Escape, and for modules that
    // scope their rows to the app the user came from.
    let previous = runwa_core::get_foreground_window()
        .ok()
        .filter(|id| !id.is_empty());
    state.focus.capture(previous.clone());

    let settings = state.settings.get();
    if let Some(p) = resolve_placement(app, &settings) {
        state.palette.state.lock().last_programmatic_resize = Some(Instant::now());
        apply_bounds(&win, p.x, p.y, p.width, p.height, p.scale);
    }

    let payload = PaletteShowPayload {
        initial_module_id: Some(module_id.to_owned()),
    };
    let listening = {
        let mut palette = state.palette.state.lock();
        palette.previous_window_id = previous;
        palette.last_shown_at = Some(Instant::now());
        palette.current_module_id = Some(module_id.to_owned());
        if !palette.renderer_listening {
            palette.pending_show = Some(payload.clone());
        }
        palette.renderer_listening
    };

    #[cfg(target_os = "macos")]
    {
        // Re-assert all-Spaces membership, clearing it first: re-setting an
        // identical value is a no-op, and the WindowServer can pin a window
        // to one Space while the flag still reads as set.
        let _ = win.set_visible_on_all_workspaces(false);
        let _ = win.set_visible_on_all_workspaces(true);
    }
    let _ = win.show();
    let _ = win.set_focus();

    // Windows foreground lock — see the module docs.
    #[cfg(target_os = "windows")]
    if let Some(hwnd) = hwnd_of(&win) {
        match runwa_core::force_foreground_window(&hwnd) {
            Ok(ok) => log::info!("[palette] show: forceForeground result={ok}"),
            Err(err) => log::warn!("[palette] forceForeground failed: {err}"),
        }
    }

    // "Switch to English on open": after the focus grab, so on Windows the
    // language request lands on the palette window.
    if settings.bool_or("paletteSwitchToEnglish", true) {
        if let Err(err) = runwa_core::set_input_language("en") {
            log::warn!("[palette] set_input_language(en) failed: {err}");
        }
    }

    if listening {
        let _ = win.emit_to(win.label(), "palette:show", payload);
    }
}

pub fn hide(app: &AppHandle, restore_focus: bool) {
    let state = controller(app);
    let previous = {
        let mut palette = state.palette.state.lock();
        palette.current_module_id = None;
        palette.move_start = None;
        // Closes the blur-grace window: the blur our own hide() causes must
        // not re-grab focus.
        palette.last_shown_at = None;
        palette.previous_window_id.take()
    };
    // Callers acting on the previously focused app read the context before
    // asking us to hide, so dropping it here can't race them.
    state.focus.clear();

    let Some(win) = window(app) else { return };
    if !win.is_visible().unwrap_or(false) {
        return;
    }
    let own_hwnd = hwnd_of(&win);
    let _ = win.hide();

    if !restore_focus {
        return;
    }
    let Some(previous) = previous else { return };
    // Restoring focus to a window that now lives on another desktop / Space
    // would drag the user there; hand focus to what's on top here instead.
    if runwa_core::is_window_on_current_desktop(&previous).unwrap_or(true) {
        let _ = runwa_core::focus_window(&previous);
    } else if let Some(own) = own_hwnd {
        if let Ok(result) = runwa_core::focus_topmost_on_current_desktop(&own) {
            for line in result.log {
                log::info!("[palette] focus_topmost: {line}");
            }
        }
    }
}

/// Hotkey entry point: open the palette for `module_id`, or handle a
/// re-press of the same module's hotkey while it's open.
pub fn toggle(app: &AppHandle, module_id: &str, second_press: SecondPress) {
    let state = controller(app);
    let same_module_open = window(app).is_some_and(|w| w.is_visible().unwrap_or(false))
        && state.palette.state.lock().current_module_id.as_deref() == Some(module_id);
    if same_module_open {
        match second_press {
            SecondPress::ActivateSecond => {
                if let Some(win) = window(app) {
                    let _ = win.emit_to(win.label(), "palette:activate-second", ());
                }
            }
            SecondPress::Dismiss => hide(app, true),
        }
        return;
    }
    show(app, module_id);
}

/// The renderer's `palette:show` listener is attached: from now on shows
/// are emitted directly. Returns a show that happened before it attached.
pub fn renderer_listening(app: &AppHandle) -> Option<PaletteShowPayload> {
    let state = controller(app);
    let mut palette = state.palette.state.lock();
    palette.renderer_listening = true;
    palette.pending_show.take()
}

pub fn on_window_event(window: &tauri::Window, event: &WindowEvent) {
    let app = window.app_handle();
    match event {
        WindowEvent::Focused(false) => on_blur(app, window),
        WindowEvent::Resized(_) => on_resized(app, window),
        WindowEvent::Destroyed => {
            let state = controller(app);
            let mut palette = state.palette.state.lock();
            if palette.label.as_deref() == Some(window.label()) {
                palette.label = None;
            }
        }
        _ => {}
    }
}

fn on_blur(app: &AppHandle, window: &tauri::Window) {
    // A blur that follows our own hide() needs no handling.
    if !window.is_visible().unwrap_or(false) {
        return;
    }
    let state = controller(app);
    let since_show = state
        .palette
        .state
        .lock()
        .last_shown_at
        .map(|at| at.elapsed());
    log::info!("[palette] blur: {since_show:?} since show");

    #[cfg(target_os = "windows")]
    if let Ok(hwnd) = window.hwnd() {
        let own = (hwnd.0 as usize).to_string();
        if since_show.is_some_and(|elapsed| elapsed < BLUR_GRACE) {
            let ok = runwa_core::force_foreground_window(&own);
            let _ = window.set_focus();
            log::info!("[palette] blur ignored: re-focus ok={ok:?}");
            return;
        }
        // The user switched desktops with the palette open: its window stays
        // behind, and Windows doesn't always promote anything on the new
        // desktop — hand focus over explicitly.
        if !runwa_core::is_window_on_current_desktop(&own).unwrap_or(true) {
            let _ = runwa_core::focus_topmost_on_current_desktop(&own);
        }
    }
    hide(app, false);
}

fn on_resized(app: &AppHandle, window: &tauri::Window) {
    let state = controller(app);
    {
        let palette = state.palette.state.lock();
        // Mid-drag, or a size we just applied ourselves.
        if palette.move_start.is_some()
            || palette
                .last_programmatic_resize
                .is_some_and(|at| at.elapsed() < PROGRAMMATIC_RESIZE_WINDOW)
        {
            return;
        }
    }
    // Only a visible palette can be resized by the user. What Windows does
    // to a hidden window across sleep (re-DPI'ing it to 2/3 of its size)
    // must never become the stored size.
    if !window.is_visible().unwrap_or(false) {
        return;
    }
    let generation = state
        .palette
        .resize_generation
        .fetch_add(1, Ordering::SeqCst)
        + 1;
    let app = app.clone();
    let label = window.label().to_owned();
    tauri::async_runtime::spawn(async move {
        tokio::time::sleep(RESIZE_PERSIST_DELAY).await;
        if controller(&app)
            .palette
            .resize_generation
            .load(Ordering::SeqCst)
            != generation
        {
            return; // superseded by a later resize
        }
        let handle = app.clone();
        let _ = app.run_on_main_thread(move || persist_size(&handle, &label));
    });
}

fn persist_size(app: &AppHandle, label: &str) {
    let Some(win) = app.get_webview_window(label) else {
        return;
    };
    let (Ok(size), Ok(scale)) = (win.inner_size(), win.scale_factor()) else {
        return;
    };
    let (width, height) = (size.width as f64 / scale, size.height as f64 / scale);
    if width < MIN_WIDTH || height < MIN_HEIGHT {
        return;
    }
    let state = controller(app);
    if let Some((w, h)) = state.settings.get().palette_size() {
        if (w - width).abs() <= DPI_ROUNDING_SLOP && (h - height).abs() <= DPI_ROUNDING_SLOP {
            return;
        }
    }
    let mut patch = serde_json::Map::new();
    patch.insert(
        "paletteSize".into(),
        serde_json::json!({ "width": width.round(), "height": height.round() }),
    );
    let settings = state.settings.patch(patch);
    crate::app::settings_changed(app, &settings);
    log::info!("[palette-bounds] persisted resize: {width:.0}x{height:.0}");
}

// ─── JS-driven drag ─────────────────────────────────────────────────────
//
// The search input can't be a drag region (it would block focus and
// typing), so the renderer streams pointer deltas once a drag passes its
// threshold. Deltas are cumulative from the drag start, in CSS pixels.

pub fn start_move(app: &AppHandle) {
    let Some(win) = window(app) else { return };
    let (Ok(pos), Ok(scale)) = (win.outer_position(), win.scale_factor()) else {
        return;
    };
    controller(app).palette.state.lock().move_start =
        Some((pos.x as f64 / scale, pos.y as f64 / scale, scale));
}

pub fn move_by(app: &AppHandle, dx: f64, dy: f64) {
    let Some((x, y, scale)) = controller(app).palette.state.lock().move_start else {
        return;
    };
    let Some(win) = window(app) else { return };
    let (x, y) = (x + dx, y + dy);
    if cfg!(target_os = "macos") {
        let _ = win.set_position(LogicalPosition::new(x.round(), y.round()));
    } else {
        let _ = win.set_position(PhysicalPosition::new(
            (x * scale).round() as i32,
            (y * scale).round() as i32,
        ));
    }
}

pub fn end_move(app: &AppHandle) {
    let state = controller(app);
    if state.palette.state.lock().move_start.take().is_none() {
        return;
    }
    let Some(win) = window(app) else { return };
    let (Ok(pos), Ok(scale)) = (win.outer_position(), win.scale_factor()) else {
        return;
    };
    let (x, y) = (
        (pos.x as f64 / scale).round(),
        (pos.y as f64 / scale).round(),
    );
    if state.settings.get().palette_position() == Some((x, y)) {
        return;
    }
    let mut patch = serde_json::Map::new();
    patch.insert(
        "palettePosition".into(),
        serde_json::json!({ "x": x, "y": y }),
    );
    let settings = state.settings.patch(patch);
    crate::app::settings_changed(app, &settings);
}
