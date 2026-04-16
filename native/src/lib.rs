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
