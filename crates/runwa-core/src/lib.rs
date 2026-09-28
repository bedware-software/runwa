//! Platform layer shared by runwa's two shells.
//!
//! Everything that talks to the OS below the UI lives here: window
//! enumeration / focus / close / icons, virtual desktops, the low-level
//! keyboard-remap hook, input-language switching, system theme, process
//! elevation and the macOS privacy (TCC) permissions.
//!
//! The crate is deliberately shell-agnostic — no napi, no Tauri. Two
//! consumers link it:
//!
//!   - `native/` — the napi-rs addon the Electron build loads. A thin facade
//!     that converts these types into JS objects.
//!   - `src-tauri/` — the Tauri app, which calls it directly.
//!
//! Errors are plain messages ([`Error`]); each shell decides how to surface
//! them (a JS exception, a rejected `invoke`, a log line).

#![deny(clippy::all)]

use serde::Serialize;

#[cfg(target_os = "windows")]
mod windows_impl;

#[cfg(target_os = "macos")]
mod macos;

mod remap;

/// Error from a fallible platform call: a human-readable reason, nothing
/// more. Mirrors napi's `Error::from_reason` so the platform modules read
/// the same as they did when they returned napi errors directly.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Error {
    reason: String,
}

impl Error {
    pub fn from_reason(reason: impl Into<String>) -> Self {
        Self {
            reason: reason.into(),
        }
    }

    pub fn reason(&self) -> &str {
        &self.reason
    }
}

impl std::fmt::Display for Error {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(&self.reason)
    }
}

impl std::error::Error for Error {}

pub type Result<T> = std::result::Result<T, Error>;

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct NativeWindow {
    pub id: String,
    pub pid: u32,
    pub title: String,
    pub process_name: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub executable_path: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub bundle_id: Option<String>,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FocusTopmostResult {
    /// `true` if `SetForegroundWindow` accepted the target; `false` if nothing
    /// qualified or Windows refused the foreground switch.
    pub ok: bool,
    /// HWND (as decimal string) of the window we picked, or `None` when no
    /// candidate passed the filters.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub picked_hwnd: Option<String>,
    /// Per-candidate diagnostic lines — one per enumerated window plus the
    /// pick/fail summary. Temporary, for AHK-interaction debugging.
    pub log: Vec<String>,
}

/// Raw BGRA pixel buffer, `width * height * 4` bytes. Sourced from the
/// window's actual icon (WM_GETICON / class icon), which differs from the
/// executable's embedded icon for UWP apps (all ApplicationFrameHost.exe),
/// Edge PWAs (all msedge.exe), and anything else hosted behind a shared exe.
#[derive(Clone, Debug)]
pub struct WindowIcon {
    pub width: u32,
    pub height: u32,
    pub bgra: Vec<u8>,
}

pub fn list_windows(
    current_desktop_only: bool,
    hide_system_windows: bool,
) -> Result<Vec<NativeWindow>> {
    #[cfg(target_os = "windows")]
    {
        windows_impl::list_windows(current_desktop_only, hide_system_windows)
    }
    #[cfg(target_os = "macos")]
    {
        macos::list_windows(current_desktop_only, hide_system_windows)
    }
    #[cfg(not(any(target_os = "windows", target_os = "macos")))]
    {
        let _ = current_desktop_only;
        let _ = hide_system_windows;
        Ok(Vec::new())
    }
}

pub fn focus_window(id: &str) -> Result<bool> {
    #[cfg(target_os = "windows")]
    {
        windows_impl::focus_window(id)
    }
    #[cfg(target_os = "macos")]
    {
        macos::focus_window(id)
    }
    #[cfg(not(any(target_os = "windows", target_os = "macos")))]
    {
        let _ = id;
        Ok(false)
    }
}

/// Ask a window to close — equivalent to clicking its close button.
/// Windows posts `WM_CLOSE`; macOS presses the AX close button (requires
/// Accessibility permission). The owning app keeps full control: it may
/// show a "save changes?" prompt or refuse, exactly like a manual click.
/// `true` means the close request was delivered, not that the window is
/// gone.
pub fn close_window(id: &str) -> Result<bool> {
    #[cfg(target_os = "windows")]
    {
        windows_impl::close_window(id)
    }
    #[cfg(target_os = "macos")]
    {
        macos::close_window(id)
    }
    #[cfg(not(any(target_os = "windows", target_os = "macos")))]
    {
        let _ = id;
        Ok(false)
    }
}

pub fn get_foreground_window() -> Result<String> {
    #[cfg(target_os = "windows")]
    {
        windows_impl::get_foreground_window()
    }
    #[cfg(target_os = "macos")]
    {
        macos::get_foreground_window()
    }
    #[cfg(not(any(target_os = "windows", target_os = "macos")))]
    {
        Ok(String::new())
    }
}

pub fn force_foreground_window(id: &str) -> Result<bool> {
    #[cfg(target_os = "windows")]
    {
        windows_impl::force_foreground_window(id)
    }
    #[cfg(not(target_os = "windows"))]
    {
        // Non-Windows platforms don't have the foreground-lock problem in the
        // same shape — the OS grants focus when the palette shows. Focus from
        // the Rust side falls back to the regular focus_window path if needed.
        let _ = id;
        Ok(true)
    }
}

pub fn describe_window(id: &str) -> Result<Option<NativeWindow>> {
    #[cfg(target_os = "windows")]
    {
        windows_impl::describe_window(id)
    }
    #[cfg(not(target_os = "windows"))]
    {
        // macOS window ids are `${pid}:${windowNumber}` strings — resolving them
        // cheaply would need CGWindowListCopyWindowInfo per call. The palette's
        // diagnostic logs are Windows-only today, so no-op on other platforms.
        let _ = id;
        Ok(None)
    }
}

/// Zero-based index of the currently active virtual desktop. Intended for a
/// one-shot read at startup to seed the initial tray icon — live updates are
/// pushed via [`set_desktop_change_callback`], not polled. Windows reads the
/// real `winvd` ordinal here. macOS has no public Space-ordinal API, so it
/// returns the last number a `switch_to_workspace` / `move_to_workspace` rule
/// action recorded (0 until the first such switch). Linux / other: always 0.
pub fn get_current_desktop_number() -> Result<u32> {
    #[cfg(target_os = "windows")]
    {
        windows_impl::get_current_desktop_number()
    }
    #[cfg(target_os = "macos")]
    {
        Ok(remap::desktop::get())
    }
    #[cfg(not(any(target_os = "windows", target_os = "macos")))]
    {
        Ok(0)
    }
}

/// Register a subscriber invoked with the new 0-based desktop ordinal every
/// time a `switch_to_workspace` / `move_to_workspace` rule action fires. The
/// keyboard-remap hook knows the destination desktop the instant the
/// operation runs and pushes it straight here, so nobody has to poll.
///
/// The callback runs on the hook thread, which Windows tears down if it
/// stalls: hand the value off (a channel send, a threadsafe-function
/// enqueue, a post to the UI thread) instead of doing work inline.
/// Registered once at startup; calling again replaces the previous
/// subscriber. No-op on platforms without virtual desktops (Linux).
pub fn set_desktop_change_callback(callback: impl Fn(u32) + Send + Sync + 'static) {
    #[cfg(any(target_os = "macos", target_os = "windows"))]
    {
        remap::desktop::set_callback(std::sync::Arc::new(callback));
    }
    #[cfg(not(any(target_os = "macos", target_os = "windows")))]
    {
        let _ = callback;
    }
}

pub fn is_window_on_current_desktop(id: &str) -> Result<bool> {
    #[cfg(target_os = "windows")]
    {
        windows_impl::is_window_on_current_desktop(id)
    }
    #[cfg(target_os = "macos")]
    {
        macos::is_window_on_current_desktop(id)
    }
    #[cfg(not(any(target_os = "windows", target_os = "macos")))]
    {
        // No virtual-desktop concept to consult — every window counts as
        // being on the current one.
        let _ = id;
        Ok(true)
    }
}

pub fn focus_topmost_on_current_desktop(exclude_id: &str) -> Result<FocusTopmostResult> {
    #[cfg(target_os = "windows")]
    {
        windows_impl::focus_topmost_on_current_desktop(exclude_id)
    }
    #[cfg(not(target_os = "windows"))]
    {
        let _ = exclude_id;
        Ok(FocusTopmostResult {
            ok: false,
            picked_hwnd: None,
            log: Vec::new(),
        })
    }
}

pub fn get_window_icon(id: &str) -> Result<Option<WindowIcon>> {
    #[cfg(target_os = "windows")]
    {
        windows_impl::get_window_icon(id)
    }
    #[cfg(not(target_os = "windows"))]
    {
        // macOS icons are per-app (NSRunningApplication.icon), resolvable from
        // the bundle identifier. Not wired yet — callers fall back to an
        // executable-based icon.
        let _ = id;
        Ok(None)
    }
}

/// Windows-only: `ExtractIconExW` pulls the icon resource straight off the
/// file (exe / dll / ico), bypassing `SHGetFileInfo`'s thumbnail cache
/// which is sparse for installer-shipped shortcuts.
pub fn get_file_icon(path: &str, icon_index: i32) -> Result<Option<WindowIcon>> {
    #[cfg(target_os = "windows")]
    {
        windows_impl::get_file_icon(path, icon_index)
    }
    #[cfg(not(target_os = "windows"))]
    {
        let _ = (path, icon_index);
        Ok(None)
    }
}

/// Windows-only: true when runwa is running with an elevated (administrator)
/// token. Everything a process launches inherits its token, so the app
/// launcher has to know this to decide whether it must actively drop back to
/// the interactive user. Always false elsewhere — no equivalent split exists.
pub fn is_process_elevated() -> bool {
    #[cfg(target_os = "windows")]
    {
        windows_impl::is_process_elevated()
    }
    #[cfg(not(target_os = "windows"))]
    {
        false
    }
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
pub fn launch_as_shell_user(exe: &str, args: Option<&str>, cwd: Option<&str>) -> Result<u32> {
    #[cfg(target_os = "windows")]
    {
        windows_impl::launch_as_shell_user(exe, args, cwd)
    }
    #[cfg(not(target_os = "windows"))]
    {
        let _ = (exe, args, cwd);
        Err(Error::from_reason("launch_as_shell_user is Windows-only"))
    }
}

/// Windows-only: start `path` elevated via the shell's `runas` verb — the
/// per-app "run as administrator" opt-in. Raises a UAC prompt when runwa
/// isn't elevated, and inherits our own elevated token when it is.
pub fn launch_elevated(path: &str, args: Option<&str>, cwd: Option<&str>) -> Result<()> {
    #[cfg(target_os = "windows")]
    {
        windows_impl::launch_elevated(path, args, cwd)
    }
    #[cfg(not(target_os = "windows"))]
    {
        let _ = (path, args, cwd);
        Err(Error::from_reason("launch_elevated is Windows-only"))
    }
}

/// macOS-only: true if this process has been granted Accessibility in
/// System Settings → Privacy & Security → Accessibility. Always true on
/// other platforms (no equivalent gate exists there).
pub fn is_accessibility_trusted() -> bool {
    #[cfg(target_os = "macos")]
    {
        macos::is_accessibility_trusted()
    }
    #[cfg(not(target_os = "macos"))]
    {
        true
    }
}

/// macOS-only: shows the one-time Accessibility permission prompt and
/// returns the trusted state. If false, the user must toggle runwa on in
/// System Settings → Privacy & Security → Accessibility and restart — AX
/// caches the trust bit per-process at launch.
pub fn request_accessibility_permission() -> bool {
    #[cfg(target_os = "macos")]
    {
        macos::request_accessibility_permission()
    }
    #[cfg(not(target_os = "macos"))]
    {
        true
    }
}

/// macOS-only: true if `CGPreflightScreenCaptureAccess` reports Screen
/// Recording permission has propagated to this process. Titles in
/// `CGWindowList` output (and therefore per-window rows in the palette)
/// require this to be true.
pub fn is_screen_recording_granted() -> bool {
    #[cfg(target_os = "macos")]
    {
        macos::is_screen_recording_granted()
    }
    #[cfg(not(target_os = "macos"))]
    {
        true
    }
}

/// macOS-only: triggers the Screen Recording permission prompt and registers
/// the app with TCC. On Sequoia, TCC often refuses to honor a manually-added
/// entry in System Settings unless the app has explicitly called this at
/// least once — so shells fire it at startup. Returns the immediate trusted
/// state; after the user grants, a relaunch is still required before
/// `CGWindowList` starts returning window titles.
pub fn request_screen_recording_permission() -> bool {
    #[cfg(target_os = "macos")]
    {
        macos::request_screen_recording_permission()
    }
    #[cfg(not(target_os = "macos"))]
    {
        true
    }
}

/// Install a cross-platform keyboard remapping hook. `rules_json` is a JSON
/// document describing the rule set (see `remap::rules`). Returns an opaque
/// handle id; pass it to [`stop_keyboard_remap`] to tear down.
pub fn start_keyboard_remap(rules_json: &str) -> Result<u32> {
    remap::start(rules_json).map_err(Error::from_reason)
}

/// Validate keyboard remap rules without installing or replacing the active
/// hook. Uses the same authoritative parser as [`start_keyboard_remap`].
pub fn validate_keyboard_remap(rules_json: &str) -> Result<()> {
    remap::validate(rules_json).map_err(Error::from_reason)
}

/// Tear down a keyboard remap hook previously installed via
/// [`start_keyboard_remap`]. Unknown handle ids return an error.
pub fn stop_keyboard_remap(handle: u32) -> Result<()> {
    remap::stop(handle).map_err(Error::from_reason)
}

/// Switch the system input language to the one matching `code` (ISO 639-1,
/// e.g. `en`, `ru`). Reuses the keyboard-remap `change_language` plumbing —
/// macOS dispatches via `TISSelectInputSource` on the main queue; Windows
/// posts `WM_INPUTLANGCHANGEREQUEST` when the foreground window is ours
/// and otherwise cycles the shell's Win+Space switcher, which is the only
/// path some TSF-based apps survive. The language must already be
/// installed as a system input source; we only activate, never add.
/// Returns an error only if `code` fails to parse.
pub fn set_input_language(code: &str) -> Result<()> {
    remap::set_input_language(code).map_err(Error::from_reason)
}

/// Replace the set of executables (bare file names, e.g. `cs2.exe`) that
/// suspend keyboard remapping while one of their windows is foreground and
/// covering its monitor. Windows-only; a no-op elsewhere. Called at startup
/// and after every edit, so the list is always a full replacement.
pub fn set_remap_fullscreen_bypass(process_names: Vec<String>) {
    remap::set_fullscreen_bypass_processes(process_names);
}

/// Read the Windows application appearance preference. Returns `"light"` or
/// `"dark"`. macOS uses an AppleScript backend in the shells, so this
/// reports unsupported elsewhere.
pub fn get_system_theme() -> Result<String> {
    #[cfg(target_os = "windows")]
    {
        windows_impl::get_system_theme()
    }
    #[cfg(not(target_os = "windows"))]
    {
        Err(Error::from_reason(
            "Native system theme control is only available on Windows",
        ))
    }
}

/// Set both the Windows application and system appearance preferences, then
/// broadcast `WM_SETTINGCHANGE` so the shell and running applications refresh.
pub fn set_system_theme(theme: &str) -> Result<()> {
    #[cfg(target_os = "windows")]
    {
        windows_impl::set_system_theme(theme)
    }
    #[cfg(not(target_os = "windows"))]
    {
        let _ = theme;
        Err(Error::from_reason(
            "Native system theme control is only available on Windows",
        ))
    }
}

/// Windows-only: reveal a solid desktop color in `#RRGGBB` format. The
/// configured picture path is left intact, but Windows picture/slideshow mode
/// is disabled until another wallpaper is applied.
pub fn set_desktop_background_color(color: &str) -> Result<()> {
    #[cfg(target_os = "windows")]
    {
        windows_impl::set_desktop_background_color(color)
    }
    #[cfg(not(target_os = "windows"))]
    {
        let _ = color;
        Err(Error::from_reason(
            "Native desktop background color control is only available on Windows",
        ))
    }
}
