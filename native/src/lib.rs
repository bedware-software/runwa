#![deny(clippy::all)]

#[macro_use]
extern crate napi_derive;

#[cfg(target_os = "windows")]
mod windows_impl;

#[cfg(target_os = "macos")]
mod macos;

mod remap;

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

#[napi]
pub fn list_windows(
  current_desktop_only: bool,
  hide_system_windows: bool,
) -> napi::Result<Vec<NativeWindow>> {
  #[cfg(target_os = "windows")]
  {
    return windows_impl::list_windows(current_desktop_only, hide_system_windows);
  }
  #[cfg(target_os = "macos")]
  {
    return macos::list_windows(current_desktop_only, hide_system_windows);
  }
  #[cfg(not(any(target_os = "windows", target_os = "macos")))]
  {
    let _ = current_desktop_only;
    let _ = hide_system_windows;
    Ok(Vec::new())
  }
}

#[napi]
pub fn focus_window(id: String) -> napi::Result<bool> {
  #[cfg(target_os = "windows")]
  {
    return windows_impl::focus_window(&id);
  }
  #[cfg(target_os = "macos")]
  {
    return macos::focus_window(&id);
  }
  #[cfg(not(any(target_os = "windows", target_os = "macos")))]
  {
    let _ = id;
    Ok(false)
  }
}

#[napi]
pub fn get_foreground_window() -> napi::Result<String> {
  #[cfg(target_os = "windows")]
  {
    return windows_impl::get_foreground_window();
  }
  #[cfg(not(target_os = "windows"))]
  {
    Ok(String::new())
  }
}

#[napi]
pub fn force_foreground_window(id: String) -> napi::Result<bool> {
  #[cfg(target_os = "windows")]
  {
    return windows_impl::force_foreground_window(&id);
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

#[napi]
pub fn describe_window(id: String) -> napi::Result<Option<NativeWindow>> {
  #[cfg(target_os = "windows")]
  {
    return windows_impl::describe_window(&id);
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

/// Zero-based index of the currently active virtual desktop. Windows
/// reads this from the real `winvd` ordinal. macOS has no public API for
/// Space ordinals, so we track our own by snooping
/// `switch_to_workspace` / `move_to_workspace` rule actions the user
/// fires through the keyboard remap — the number is passed in the rule,
/// so every runwa-initiated switch updates the tracker. Switches made
/// via the system's own Ctrl+N shortcut (outside runwa) aren't observed
/// and won't be reflected. Linux / other: always 0.
#[napi]
pub fn get_current_desktop_number() -> napi::Result<u32> {
  #[cfg(target_os = "windows")]
  {
    return windows_impl::get_current_desktop_number();
  }
  #[cfg(target_os = "macos")]
  {
    return Ok(remap::macos_desktop_tracker::get());
  }
  #[cfg(not(any(target_os = "windows", target_os = "macos")))]
  {
    Ok(0)
  }
}

#[napi]
pub fn is_window_on_current_desktop(id: String) -> napi::Result<bool> {
  #[cfg(target_os = "windows")]
  {
    return windows_impl::is_window_on_current_desktop(&id);
  }
  #[cfg(not(target_os = "windows"))]
  {
    // macOS Spaces membership check would need private CGS APIs; we don't
    // have a cross-desktop restore issue today because macOS handles Space
    // switching for us when focusing a process by PID.
    let _ = id;
    Ok(true)
  }
}

#[napi]
pub fn focus_topmost_on_current_desktop(exclude_id: String) -> napi::Result<FocusTopmostResult> {
  #[cfg(target_os = "windows")]
  {
    return windows_impl::focus_topmost_on_current_desktop(&exclude_id);
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

#[napi]
pub fn get_window_icon(id: String) -> napi::Result<Option<WindowIcon>> {
  #[cfg(target_os = "windows")]
  {
    return windows_impl::get_window_icon(&id);
  }
  #[cfg(not(target_os = "windows"))]
  {
    // macOS icons are per-app (NSRunningApplication.icon), resolvable from
    // the bundle identifier. Not wired yet — macOS path still relies on the
    // executable-based icon fallback on the TS side.
    let _ = id;
    Ok(None)
  }
}

/// Windows-only fallback when Electron's `app.getFileIcon` returns an
/// empty image — `ExtractIconExW` pulls the icon resource straight off
/// the file (exe / dll / ico), bypassing `SHGetFileInfo`'s thumbnail
/// cache which is sparse for installer-shipped shortcuts.
#[napi]
pub fn get_file_icon(
  path: String,
  icon_index: Option<i32>,
) -> napi::Result<Option<WindowIcon>> {
  #[cfg(target_os = "windows")]
  {
    return windows_impl::get_file_icon(&path, icon_index.unwrap_or(0));
  }
  #[cfg(not(target_os = "windows"))]
  {
    let _ = (path, icon_index);
    Ok(None)
  }
}

/// macOS-only: true if this process has been granted Accessibility in
/// System Settings → Privacy & Security → Accessibility. Always true on
/// other platforms (no equivalent gate exists there).
#[napi]
pub fn is_accessibility_trusted() -> bool {
  #[cfg(target_os = "macos")]
  {
    return macos::is_accessibility_trusted();
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
#[napi]
pub fn request_accessibility_permission() -> bool {
  #[cfg(target_os = "macos")]
  {
    return macos::request_accessibility_permission();
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
#[napi]
pub fn is_screen_recording_granted() -> bool {
  #[cfg(target_os = "macos")]
  {
    return macos::is_screen_recording_granted();
  }
  #[cfg(not(target_os = "macos"))]
  {
    true
  }
}

/// macOS-only: triggers the Screen Recording permission prompt and registers
/// the app with TCC. On Sequoia, TCC often refuses to honor a manually-added
/// entry in System Settings unless the app has explicitly called this at
/// least once — so we fire it at startup. Returns the immediate trusted
/// state; after the user grants, a relaunch is still required before
/// `CGWindowList` starts returning window titles.
#[napi]
pub fn request_screen_recording_permission() -> bool {
  #[cfg(target_os = "macos")]
  {
    return macos::request_screen_recording_permission();
  }
  #[cfg(not(target_os = "macos"))]
  {
    true
  }
}

/// Install a cross-platform keyboard remapping hook. `rules_json` is a JSON5
/// document describing the rule set (see `remap::rules::DEFAULT_RULES_JSON`).
/// Returns an opaque handle id; pass it to `stop_keyboard_remap` to tear down.
#[napi]
pub fn start_keyboard_remap(rules_json: String) -> napi::Result<u32> {
  remap::start(&rules_json).map_err(|e| napi::Error::from_reason(e))
}

/// Tear down a keyboard remap hook previously installed via
/// `start_keyboard_remap`. Unknown handle ids return an error.
#[napi]
pub fn stop_keyboard_remap(handle: u32) -> napi::Result<()> {
  remap::stop(handle).map_err(|e| napi::Error::from_reason(e))
}
