#![deny(clippy::all)]

#[macro_use]
extern crate napi_derive;

#[cfg(target_os = "windows")]
mod windows_impl;

#[cfg(target_os = "macos")]
mod macos;

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
