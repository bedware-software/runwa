#![deny(clippy::all)]

//! napi-rs facade over `runwa-core` for the Electron build.
//!
//! All platform code lives in `crates/runwa-core`, which the Tauri app links
//! directly. This crate only converts between core types and JS values, so
//! the JS API — and the generated `index.d.ts` — is unchanged. It goes away
//! together with the Electron shell.

#[macro_use]
extern crate napi_derive;

fn to_napi(err: runwa_core::Error) -> napi::Error {
    napi::Error::from_reason(err.to_string())
}

#[napi(object)]
#[derive(Clone)]
pub struct NativeWindow {
    pub id: String,
    pub pid: u32,
    pub title: String,
    pub process_name: String,
    pub executable_path: Option<String>,
    pub bundle_id: Option<String>,
}

impl From<runwa_core::NativeWindow> for NativeWindow {
    fn from(w: runwa_core::NativeWindow) -> Self {
        Self {
            id: w.id,
            pid: w.pid,
            title: w.title,
            process_name: w.process_name,
            executable_path: w.executable_path,
            bundle_id: w.bundle_id,
        }
    }
}

#[napi(object)]
pub struct FocusTopmostResult {
    /// `true` if `SetForegroundWindow` accepted the target; `false` if nothing
    /// qualified or Windows refused the foreground switch.
    pub ok: bool,
    /// HWND (as decimal string) of the window we picked, or `None` when no
    /// candidate passed the filters.
    pub picked_hwnd: Option<String>,
    /// Per-candidate diagnostic lines — one per enumerated window plus the
    /// pick/fail summary. Temporary, for AHK-interaction debugging.
    pub log: Vec<String>,
}

impl From<runwa_core::FocusTopmostResult> for FocusTopmostResult {
    fn from(r: runwa_core::FocusTopmostResult) -> Self {
        Self {
            ok: r.ok,
            picked_hwnd: r.picked_hwnd,
            log: r.log,
        }
    }
}

/// Raw BGRA pixel buffer suitable for `nativeImage.createFromBitmap` on the
/// TypeScript side (Electron's per-platform default is BGRA). Sourced from
/// the window's actual icon (WM_GETICON / class icon), which differs from
/// the executable's embedded icon for UWP apps (all ApplicationFrameHost.exe),
/// Edge PWAs (all msedge.exe), and anything else hosted behind a shared exe.
#[napi(object)]
pub struct WindowIcon {
    pub width: u32,
    pub height: u32,
    pub bgra: napi::bindgen_prelude::Buffer,
}

impl From<runwa_core::WindowIcon> for WindowIcon {
    fn from(icon: runwa_core::WindowIcon) -> Self {
        Self {
            width: icon.width,
            height: icon.height,
            bgra: icon.bgra.into(),
        }
    }
}

#[napi]
pub fn list_windows(
    current_desktop_only: bool,
    hide_system_windows: bool,
) -> napi::Result<Vec<NativeWindow>> {
    runwa_core::list_windows(current_desktop_only, hide_system_windows)
        .map(|windows| windows.into_iter().map(NativeWindow::from).collect())
        .map_err(to_napi)
}

#[napi]
pub fn focus_window(id: String) -> napi::Result<bool> {
    runwa_core::focus_window(&id).map_err(to_napi)
}

/// Ask a window to close — equivalent to clicking its close button.
/// Windows posts `WM_CLOSE`; macOS presses the AX close button (requires
/// Accessibility permission). The owning app keeps full control: it may
/// show a "save changes?" prompt or refuse, exactly like a manual click.
/// `true` means the close request was delivered, not that the window is
/// gone.
#[napi]
pub fn close_window(id: String) -> napi::Result<bool> {
    runwa_core::close_window(&id).map_err(to_napi)
}

#[napi]
pub fn get_foreground_window() -> napi::Result<String> {
    runwa_core::get_foreground_window().map_err(to_napi)
}

#[napi]
pub fn force_foreground_window(id: String) -> napi::Result<bool> {
    runwa_core::force_foreground_window(&id).map_err(to_napi)
}

#[napi]
pub fn describe_window(id: String) -> napi::Result<Option<NativeWindow>> {
    runwa_core::describe_window(&id)
        .map(|window| window.map(NativeWindow::from))
        .map_err(to_napi)
}

/// Zero-based index of the currently active virtual desktop. Intended for a
/// one-shot read at startup to seed the initial tray icon — live updates are
/// pushed via `set_desktop_change_callback`, not polled. Windows reads the
/// real `winvd` ordinal here. macOS has no public Space-ordinal API, so it
/// returns the last number a `switch_to_workspace` / `move_to_workspace` rule
/// action recorded (0 until the first such switch). Linux / other: always 0.
#[napi]
pub fn get_current_desktop_number() -> napi::Result<u32> {
    runwa_core::get_current_desktop_number().map_err(to_napi)
}

/// Register a JS callback invoked with the new 0-based desktop ordinal every
/// time a `switch_to_workspace` / `move_to_workspace` rule action fires. This
/// replaces tray-side polling: the keyboard-remap hook knows the destination
/// desktop the instant the operation runs and pushes it straight to JS via a
/// threadsafe function. Registered once at startup; calling again replaces the
/// previous subscriber. No-op on platforms without virtual desktops (Linux).
#[napi]
pub fn set_desktop_change_callback(callback: napi::JsFunction) -> napi::Result<()> {
    #[cfg(any(target_os = "macos", target_os = "windows"))]
    {
        use napi::threadsafe_function::{
            ErrorStrategy, ThreadSafeCallContext, ThreadsafeFunction, ThreadsafeFunctionCallMode,
        };
        let tsfn: ThreadsafeFunction<u32, ErrorStrategy::Fatal> = callback
            .create_threadsafe_function(0, |ctx: ThreadSafeCallContext<u32>| Ok(vec![ctx.value]))?;
        // Non-blocking: enqueues onto the Node event loop and returns at once,
        // which is what the hook thread calling this requires.
        runwa_core::set_desktop_change_callback(move |desktop| {
            tsfn.call(desktop, ThreadsafeFunctionCallMode::NonBlocking);
        });
        Ok(())
    }
    #[cfg(not(any(target_os = "macos", target_os = "windows")))]
    {
        let _ = callback;
        Ok(())
    }
}

#[napi]
pub fn is_window_on_current_desktop(id: String) -> napi::Result<bool> {
    runwa_core::is_window_on_current_desktop(&id).map_err(to_napi)
}

#[napi]
pub fn focus_topmost_on_current_desktop(exclude_id: String) -> napi::Result<FocusTopmostResult> {
    runwa_core::focus_topmost_on_current_desktop(&exclude_id)
        .map(FocusTopmostResult::from)
        .map_err(to_napi)
}

#[napi]
pub fn get_window_icon(id: String) -> napi::Result<Option<WindowIcon>> {
    runwa_core::get_window_icon(&id)
        .map(|icon| icon.map(WindowIcon::from))
        .map_err(to_napi)
}

/// Windows-only fallback when Electron's `app.getFileIcon` returns an
/// empty image — `ExtractIconExW` pulls the icon resource straight off
/// the file (exe / dll / ico), bypassing `SHGetFileInfo`'s thumbnail
/// cache which is sparse for installer-shipped shortcuts.
#[napi]
pub fn get_file_icon(path: String, icon_index: Option<i32>) -> napi::Result<Option<WindowIcon>> {
    runwa_core::get_file_icon(&path, icon_index.unwrap_or(0))
        .map(|icon| icon.map(WindowIcon::from))
        .map_err(to_napi)
}

/// Windows-only: true when runwa is running with an elevated (administrator)
/// token. Everything a process launches inherits its token, so the app
/// launcher has to know this to decide whether it must actively drop back to
/// the interactive user. Always false elsewhere — no equivalent split exists.
#[napi]
pub fn is_process_elevated() -> bool {
    runwa_core::is_process_elevated()
}

/// Windows-only: start `exe` as the plain interactive user, whatever token we
/// hold ourselves, by borrowing a primary token from the desktop shell.
/// Returns the new process id. `args` is a raw command-line tail (as stored in
/// a shortcut), `cwd` the working directory to start in.
///
/// Only usable from an elevated process — creating a process with someone
/// else's token needs SE_IMPERSONATE_NAME, which an ordinary user token
/// doesn't carry. Callers that aren't elevated have nothing to fix and should
/// launch through the shell as usual.
#[napi]
pub fn launch_as_shell_user(
    exe: String,
    args: Option<String>,
    cwd: Option<String>,
) -> napi::Result<u32> {
    runwa_core::launch_as_shell_user(&exe, args.as_deref(), cwd.as_deref()).map_err(to_napi)
}

/// Windows-only: start `path` elevated via the shell's `runas` verb — the
/// per-app "run as administrator" opt-in. Raises a UAC prompt when runwa
/// isn't elevated, and inherits our own elevated token when it is.
#[napi]
pub fn launch_elevated(
    path: String,
    args: Option<String>,
    cwd: Option<String>,
) -> napi::Result<()> {
    runwa_core::launch_elevated(&path, args.as_deref(), cwd.as_deref()).map_err(to_napi)
}

/// macOS-only: true if this process has been granted Accessibility in
/// System Settings → Privacy & Security → Accessibility. Always true on
/// other platforms (no equivalent gate exists there).
#[napi]
pub fn is_accessibility_trusted() -> bool {
    runwa_core::is_accessibility_trusted()
}

/// macOS-only: shows the one-time Accessibility permission prompt and
/// returns the trusted state. If false, the user must toggle runwa on in
/// System Settings → Privacy & Security → Accessibility and restart — AX
/// caches the trust bit per-process at launch.
#[napi]
pub fn request_accessibility_permission() -> bool {
    runwa_core::request_accessibility_permission()
}

/// macOS-only: true if `CGPreflightScreenCaptureAccess` reports Screen
/// Recording permission has propagated to this process. Titles in
/// `CGWindowList` output (and therefore per-window rows in the palette)
/// require this to be true.
#[napi]
pub fn is_screen_recording_granted() -> bool {
    runwa_core::is_screen_recording_granted()
}

/// macOS-only: triggers the Screen Recording permission prompt and registers
/// the app with TCC. On Sequoia, TCC often refuses to honor a manually-added
/// entry in System Settings unless the app has explicitly called this at
/// least once — so we fire it at startup. Returns the immediate trusted
/// state; after the user grants, a relaunch is still required before
/// `CGWindowList` starts returning window titles.
#[napi]
pub fn request_screen_recording_permission() -> bool {
    runwa_core::request_screen_recording_permission()
}

/// Install a cross-platform keyboard remapping hook. `rules_json` is a JSON5
/// document describing the rule set (see `remap::rules::DEFAULT_RULES_JSON`).
/// Returns an opaque handle id; pass it to `stop_keyboard_remap` to tear down.
#[napi]
pub fn start_keyboard_remap(rules_json: String) -> napi::Result<u32> {
    runwa_core::start_keyboard_remap(&rules_json).map_err(to_napi)
}

/// Validate keyboard remap rules without installing or replacing the active
/// hook. Uses the same authoritative Rust parser as `start_keyboard_remap`.
#[napi]
pub fn validate_keyboard_remap(rules_json: String) -> napi::Result<()> {
    runwa_core::validate_keyboard_remap(&rules_json).map_err(to_napi)
}

/// Tear down a keyboard remap hook previously installed via
/// `start_keyboard_remap`. Unknown handle ids return an error.
#[napi]
pub fn stop_keyboard_remap(handle: u32) -> napi::Result<()> {
    runwa_core::stop_keyboard_remap(handle).map_err(to_napi)
}

/// Switch the system input language to the one matching `code` (ISO 639-1,
/// e.g. `en`, `ru`). Reuses the keyboard-remap `change_language` plumbing —
/// macOS dispatches via `TISSelectInputSource` on the main queue; Windows
/// posts `WM_INPUTLANGCHANGEREQUEST` when the foreground window is ours
/// and otherwise cycles the shell's Win+Space switcher, which is the only
/// path some TSF-based apps survive. The language must already be
/// installed as a system input source; we only activate, never add.
/// Returns an error only if `code` fails to parse.
#[napi]
pub fn set_input_language(code: String) -> napi::Result<()> {
    runwa_core::set_input_language(&code).map_err(to_napi)
}

/// Replace the set of executables (bare file names, e.g. `cs2.exe`) that
/// suspend keyboard remapping while one of their windows is foreground and
/// covering its monitor. Windows-only; a no-op elsewhere. Called at startup
/// and after every edit, so the list is always a full replacement.
#[napi]
pub fn set_remap_fullscreen_bypass(process_names: Vec<String>) {
    runwa_core::set_remap_fullscreen_bypass(process_names);
}

/// Read the Windows application appearance preference. Returns `"light"` or
/// `"dark"`. The TypeScript system-theme driver uses an AppleScript backend on
/// macOS, so this native API intentionally reports unsupported elsewhere.
#[napi]
pub fn get_system_theme() -> napi::Result<String> {
    runwa_core::get_system_theme().map_err(to_napi)
}

/// Set both the Windows application and system appearance preferences, then
/// broadcast `WM_SETTINGCHANGE` so the shell and running applications refresh.
#[napi]
pub fn set_system_theme(theme: String) -> napi::Result<()> {
    runwa_core::set_system_theme(&theme).map_err(to_napi)
}

/// Windows-only: reveal a solid desktop color in `#RRGGBB` format. The
/// configured picture path is left intact, but Windows picture/slideshow mode
/// is disabled until another wallpaper is applied.
#[napi]
pub fn set_desktop_background_color(color: String) -> napi::Result<()> {
    runwa_core::set_desktop_background_color(&color).map_err(to_napi)
}
