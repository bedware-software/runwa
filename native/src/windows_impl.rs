use crate::NativeWindow;
use std::cell::OnceCell;
use std::ffi::c_void;
use windows::core::PWSTR;
use windows::Win32::Foundation::{CloseHandle, BOOL, HWND, LPARAM, TRUE};
use windows::Win32::Graphics::Dwm::{
  DwmGetWindowAttribute, DWMWA_CLOAKED, DWM_CLOAKED_SHELL,
};
use windows::Win32::System::Com::{
  CoCreateInstance, CoInitializeEx, CLSCTX_INPROC_SERVER, COINIT_APARTMENTTHREADED,
};
use windows::Win32::System::Threading::{
  OpenProcess, QueryFullProcessImageNameW, PROCESS_NAME_WIN32, PROCESS_QUERY_LIMITED_INFORMATION,
};
use windows::Win32::UI::Shell::{IVirtualDesktopManager, VirtualDesktopManager};
use windows::Win32::UI::WindowsAndMessaging::{
  EnumWindows, GetForegroundWindow, GetWindow, GetWindowLongW, GetWindowTextLengthW,
  GetWindowTextW, GetWindowThreadProcessId, IsIconic, IsWindowVisible, SetForegroundWindow,
  ShowWindow, GWL_EXSTYLE, GW_OWNER, SW_RESTORE, WS_EX_TOOLWINDOW,
};

thread_local! {
  /// Cached COM init marker — COM is initialized once per napi worker thread.
  static COM_INIT: OnceCell<()> = const { OnceCell::new() };
}

fn ensure_com_init() {
  COM_INIT.with(|cell| {
    cell.get_or_init(|| unsafe {
      // RPC_E_CHANGED_MODE (thread already init'd with different mode) is
      // harmless — CoCreateInstance still works against the existing apartment.
      let _ = CoInitializeEx(None, COINIT_APARTMENTTHREADED);
    });
  });
}

fn create_virtual_desktop_manager() -> Option<IVirtualDesktopManager> {
  ensure_com_init();
  unsafe {
    CoCreateInstance::<_, IVirtualDesktopManager>(
      &VirtualDesktopManager,
      None,
      CLSCTX_INPROC_SERVER,
    )
    .ok()
  }
}

extern "system" fn enum_windows_proc(hwnd: HWND, lparam: LPARAM) -> BOOL {
  unsafe {
    // Reconstruct the &mut Vec from the lparam pointer
    let collector = &mut *(lparam.0 as *mut Vec<NativeWindow>);

    // Skip invisible windows
    if !IsWindowVisible(hwnd).as_bool() {
      return TRUE;
    }

    // Skip owned / child windows (tool windows, dialogs, etc.)
    if let Ok(owner) = GetWindow(hwnd, GW_OWNER) {
      if !owner.is_invalid() {
        return TRUE;
      }
    }

    // Skip tool windows via extended style bit
    let ex_style = GetWindowLongW(hwnd, GWL_EXSTYLE);
    if (ex_style as u32 & WS_EX_TOOLWINDOW.0) != 0 {
      return TRUE;
    }

    // Skip windows with empty titles
    let title_len = GetWindowTextLengthW(hwnd);
    if title_len <= 0 {
      return TRUE;
    }

    let mut title_buf = vec![0u16; (title_len as usize) + 1];
    let copied = GetWindowTextW(hwnd, &mut title_buf);
    if copied <= 0 {
      return TRUE;
    }
    let title = String::from_utf16_lossy(&title_buf[..copied as usize]);

    // Fetch pid + executable path
    let mut pid: u32 = 0;
    GetWindowThreadProcessId(hwnd, Some(&mut pid));
    let (process_name, executable_path) = get_process_info(pid);

    collector.push(NativeWindow {
      id: (hwnd.0 as isize).to_string(),
      pid,
      title,
      process_name,
      executable_path,
      bundle_id: None,
    });

    TRUE
  }
}

/// Read the DWM cloak state for a window.
///
/// Returns the raw bitfield from `DWMWA_CLOAKED`:
///   `DWM_CLOAKED_APP`       (0x1) — cloaked by the owning app (suspended UWP host)
///   `DWM_CLOAKED_SHELL`     (0x2) — cloaked by the shell (window is on another virtual desktop)
///   `DWM_CLOAKED_INHERITED` (0x4) — cloaked because an ancestor is cloaked
///
/// A value of 0 means the window is genuinely visible. On failure we return 0
/// (i.e. "not cloaked") so we never hide a window because of a DWM hiccup.
fn get_cloak_state(hwnd: HWND) -> u32 {
  let mut cloaked: u32 = 0;
  unsafe {
    let _ = DwmGetWindowAttribute(
      hwnd,
      DWMWA_CLOAKED,
      &mut cloaked as *mut u32 as *mut c_void,
      std::mem::size_of::<u32>() as u32,
    );
  }
  cloaked
}

fn get_process_info(pid: u32) -> (String, Option<String>) {
  unsafe {
    let handle = match OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, false, pid) {
      Ok(h) => h,
      Err(_) => return (String::new(), None),
    };

    let mut buf = [0u16; 1024];
    let mut size: u32 = buf.len() as u32;
    let pwstr = PWSTR(buf.as_mut_ptr());
    let query_ok = QueryFullProcessImageNameW(handle, PROCESS_NAME_WIN32, pwstr, &mut size).is_ok();
    let _ = CloseHandle(handle);

    if !query_ok || size == 0 {
      return (String::new(), None);
    }

    let full_path = String::from_utf16_lossy(&buf[..size as usize]);
    let process_name = std::path::Path::new(&full_path)
      .file_name()
      .and_then(|s| s.to_str())
      .unwrap_or("")
      .to_string();

    (process_name, Some(full_path))
  }
}

pub fn list_windows(
  current_desktop_only: bool,
  hide_system_windows: bool,
) -> napi::Result<Vec<NativeWindow>> {
  let mut collector: Vec<NativeWindow> = Vec::new();
  let lparam = LPARAM(&mut collector as *mut Vec<NativeWindow> as isize);

  unsafe {
    EnumWindows(Some(enum_windows_proc), lparam)
      .map_err(|e| napi::Error::from_reason(format!("EnumWindows failed: {e}")))?;
  }

  // Drop DWM-cloaked windows. Shell surfaces like Start, Search, Notification
  // Center, TextInputHost, LockApp, etc. are real HWNDs that pass the
  // `IsWindowVisible` + tool-window checks but are cloaked by DWM because the
  // underlying UWP app is suspended — they're never actually drawn.
  //
  // When listing across all desktops (`current_desktop_only = false`) we keep
  // `DWM_CLOAKED_SHELL`-only windows, since that bit marks windows parked on
  // another virtual desktop and the user explicitly asked to see them.
  if hide_system_windows {
    collector.retain(|w| {
      let Ok(hwnd_val) = w.id.parse::<isize>() else {
        return true;
      };
      let hwnd = HWND(hwnd_val as *mut _);
      let cloaked = get_cloak_state(hwnd);
      if cloaked == 0 {
        return true;
      }
      if current_desktop_only {
        // Any cloak bit means the window isn't showing on this desktop.
        return false;
      }
      // Cross-desktop listing: only drop if *some* bit other than
      // DWM_CLOAKED_SHELL is set (i.e. the owning app cloaked it).
      (cloaked & !DWM_CLOAKED_SHELL) == 0
    });
  }

  if current_desktop_only {
    if let Some(vdm) = create_virtual_desktop_manager() {
      collector.retain(|w| {
        let Ok(hwnd_val) = w.id.parse::<isize>() else {
          return true;
        };
        let hwnd = HWND(hwnd_val as *mut _);
        unsafe {
          match vdm.IsWindowOnCurrentVirtualDesktop(hwnd) {
            Ok(on_current) => on_current.as_bool(),
            // Permissive: some windows (e.g. cloaked UWP hosts) reject the
            // query outright. Keep them rather than silently dropping.
            Err(_) => true,
          }
        }
      });
    } else {
      eprintln!(
        "[runwa-native] IVirtualDesktopManager unavailable — skipping current-desktop filter"
      );
    }
  }

  Ok(collector)
}

pub fn focus_window(id: &str) -> napi::Result<bool> {
  let hwnd_val: isize = id
    .parse()
    .map_err(|_| napi::Error::from_reason(format!("invalid window id: {id}")))?;

  let hwnd = HWND(hwnd_val as *mut _);

  unsafe {
    // Only restore if the window is minimized. SW_RESTORE also de-maximizes
    // maximized windows, which the user does not expect.
    if IsIconic(hwnd).as_bool() {
      let _ = ShowWindow(hwnd, SW_RESTORE);
    }
    // Bring to foreground. Returns false if the foreground-lock prevents it —
    // the caller treats false as "window gone" / "refresh listing".
    Ok(SetForegroundWindow(hwnd).as_bool())
  }
}

pub fn get_foreground_window() -> napi::Result<String> {
  unsafe {
    let hwnd = GetForegroundWindow();
    Ok((hwnd.0 as isize).to_string())
  }
}
