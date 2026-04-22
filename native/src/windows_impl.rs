use crate::{FocusTopmostResult, NativeWindow, WindowIcon};
use std::cell::OnceCell;
use std::ffi::c_void;
use windows::core::PWSTR;
use windows::Win32::Foundation::{CloseHandle, BOOL, HWND, LPARAM, RECT, TRUE, WPARAM};
use windows::Win32::Graphics::Dwm::{
  DwmGetWindowAttribute, DWMWA_CLOAKED, DWM_CLOAKED_SHELL,
};
use windows::Win32::Graphics::Gdi::{
  CreateCompatibleDC, CreateDIBSection, DeleteDC, DeleteObject, GetDC, GetObjectW,
  MonitorFromWindow, ReleaseDC, SelectObject, BITMAP, BITMAPINFO, BITMAPINFOHEADER, BI_RGB,
  DIB_RGB_COLORS, HBITMAP, HGDIOBJ, MONITOR_DEFAULTTONULL,
};
use windows::Win32::System::Com::{
  CoCreateInstance, CoInitializeEx, CLSCTX_INPROC_SERVER, COINIT_APARTMENTTHREADED,
};
use windows::Win32::System::Threading::{
  AttachThreadInput, GetCurrentThreadId, OpenProcess, QueryFullProcessImageNameW,
  PROCESS_NAME_WIN32, PROCESS_QUERY_LIMITED_INFORMATION,
};
use windows::Win32::UI::Shell::{IVirtualDesktopManager, VirtualDesktopManager};
use windows::Win32::UI::WindowsAndMessaging::{
  BringWindowToTop, DrawIconEx, EnumChildWindows, EnumWindows, GetClassLongPtrW, GetClassNameW,
  GetForegroundWindow, GetIconInfo, GetTopWindow, GetWindow, GetWindowLongW, GetWindowRect,
  GetWindowTextLengthW, GetWindowTextW, GetWindowThreadProcessId, IsIconic, IsWindowVisible,
  SendMessageTimeoutW, SetForegroundWindow, ShowWindow, DI_NORMAL, GCL_HICON, GCL_HICONSM,
  GWL_EXSTYLE, GW_HWNDNEXT, GW_OWNER, HICON, ICONINFO, ICON_BIG, ICON_SMALL, ICON_SMALL2,
  SMTO_ABORTIFHUNG, SW_RESTORE, WM_GETICON, WS_EX_TOOLWINDOW,
};

thread_local! {
  /// Cached COM init marker — COM is initialized once per napi worker thread.
  static COM_INIT: OnceCell<()> = const { OnceCell::new() };
}

/// Append one line to `%TEMP%\runwa-native.log`. Used for the focus-topmost
/// diagnostic during AHK-interaction debugging. Windows GUI-subsystem
/// processes (which Electron main is) have no usable stdout/stderr handle —
/// `eprintln!` silently drops. A file is the simplest robust sink.
fn diag_log(msg: &str) {
  use std::io::Write;
  let Some(dir) = std::env::var_os("TEMP").or_else(|| std::env::var_os("TMP")) else {
    return;
  };
  let path = std::path::Path::new(&dir).join("runwa-native.log");
  if let Ok(mut f) = std::fs::OpenOptions::new().create(true).append(true).open(&path) {
    let _ = writeln!(f, "{msg}");
  }
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
    let (mut process_name, mut executable_path) = get_process_info(pid);
    let mut effective_pid = pid;

    // UWP host pivot: `ApplicationFrameHost.exe` is a generic frame around
    // the real UWP app process, which owns the `Windows.UI.Core.CoreWindow`
    // child HWND. Swap in the inner process so:
    //   - `executable_path` points at e.g. `SystemSettings.exe`, which the
    //     shell resolves to the real UWP app icon via `app.getFileIcon`
    //   - `process_name` reads as the actual app's exe in the palette's
    //     subtitle, not a generic "ApplicationFrameHost.exe" label
    // The outer HWND is kept as the `id` — focusing it still works because
    // SetForegroundWindow on the host routes the activation correctly.
    if is_application_frame_host_name(&process_name) {
      if let Some(core) = find_uwp_core_window(hwnd) {
        let mut core_pid: u32 = 0;
        GetWindowThreadProcessId(core, Some(&mut core_pid));
        if core_pid != 0 && core_pid != pid {
          let (core_name, core_path) = get_process_info(core_pid);
          if !core_name.is_empty() {
            process_name = core_name;
            executable_path = core_path;
            effective_pid = core_pid;
          }
        }
      }
    }

    collector.push(NativeWindow {
      id: (hwnd.0 as isize).to_string(),
      pid: effective_pid,
      title,
      process_name,
      executable_path,
      bundle_id: None,
    });

    TRUE
  }
}

fn is_application_frame_host_name(name: &str) -> bool {
  name.eq_ignore_ascii_case("ApplicationFrameHost.exe")
}

unsafe fn is_application_frame_host(hwnd: HWND) -> bool {
  let mut pid: u32 = 0;
  GetWindowThreadProcessId(hwnd, Some(&mut pid));
  if pid == 0 {
    return false;
  }
  let (name, _) = get_process_info(pid);
  is_application_frame_host_name(&name)
}

/// Walk the HWND's descendant tree looking for the `Windows.UI.Core.CoreWindow`
/// class — that window lives in the actual UWP app's process. Returns `None`
/// for non-UWP hosts or when the CoreWindow hasn't been created yet (splash /
/// early-init state).
unsafe fn find_uwp_core_window(parent: HWND) -> Option<HWND> {
  extern "system" fn find_core_proc(hwnd: HWND, lparam: LPARAM) -> BOOL {
    unsafe {
      let slot = &mut *(lparam.0 as *mut Option<HWND>);
      let mut buf = [0u16; 64];
      let len = GetClassNameW(hwnd, &mut buf);
      if len > 0 && (len as usize) < buf.len() {
        let cls = String::from_utf16_lossy(&buf[..len as usize]);
        if cls == "Windows.UI.Core.CoreWindow" {
          *slot = Some(hwnd);
          return BOOL(0); // stop enumerating
        }
      }
      TRUE
    }
  }

  let mut found: Option<HWND> = None;
  let _ = EnumChildWindows(
    parent,
    Some(find_core_proc),
    LPARAM(&mut found as *mut _ as isize),
  );
  found
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

/// Force a window to the foreground, bypassing Windows' foreground-lock.
///
/// `SetForegroundWindow` is routinely refused when the calling process isn't
/// the current foreground owner (anti-stealing policy). The classic bypass is
/// to attach our thread's input queue to the current foreground thread's queue
/// — once attached, the system treats both threads as the same focus context,
/// so `SetForegroundWindow` succeeds. This is the same trick Flow Launcher,
/// Wox and PowerToys Command Palette use.
///
/// Without this, pressing a global hotkey to show the palette leaves the
/// previously-focused window owning the foreground (and any still-held
/// modifier keys from the hotkey chord), so the next keystroke fires a
/// shortcut on the wrong window — e.g. Alt+Space → system menu on the IDE.
pub fn force_foreground_window(id: &str) -> napi::Result<bool> {
  let hwnd_val: isize = id
    .parse()
    .map_err(|_| napi::Error::from_reason(format!("invalid window id: {id}")))?;
  let hwnd = HWND(hwnd_val as *mut _);

  unsafe {
    let fg = GetForegroundWindow();
    if fg.is_invalid() || fg.0 == hwnd.0 {
      return Ok(SetForegroundWindow(hwnd).as_bool());
    }

    let fg_thread = GetWindowThreadProcessId(fg, None);
    let our_thread = GetCurrentThreadId();

    if fg_thread == 0 || fg_thread == our_thread {
      return Ok(SetForegroundWindow(hwnd).as_bool());
    }

    let attached = AttachThreadInput(our_thread, fg_thread, true).as_bool();
    let _ = BringWindowToTop(hwnd);
    let ok = SetForegroundWindow(hwnd).as_bool();
    if attached {
      let _ = AttachThreadInput(our_thread, fg_thread, false);
    }
    Ok(ok)
  }
}

/// Walk the top-level windows in Z-order (topmost first) and focus the first
/// visible, non-system, non-excluded window that lives on the current virtual
/// desktop *and* is actually drawn within a monitor's bounds.
///
/// Used as a fallback when the palette's remembered "previous foreground"
/// HWND can't be refocused (e.g. it was on a different virtual desktop and
/// re-focusing it would yank the user across desktops). In that case we just
/// hand focus to whatever's on top of the current desktop — the natural
/// "cancel and go back to my work" result.
///
/// The on-monitor check is what filters out AutoHotkey's hidden helper GUIs:
/// they pass every classic filter (visible, titled, not a tool window, not
/// cloaked, on current desktop) but sit at (-32000,-32000) or 0×0, so
/// `MonitorFromWindow(..., MONITOR_DEFAULTTONULL)` returns null.
///
/// Returns both the outcome and a per-candidate log so callers can print
/// diagnostics. Also mirrors the log to `%TEMP%\runwa-native.log` as a
/// post-mortem sink. Temporary diagnostic — drop the `log` field once the
/// AHK-interaction story is nailed down.
pub fn focus_topmost_on_current_desktop(exclude_id: &str) -> napi::Result<FocusTopmostResult> {
  let exclude_hwnd_val: isize = exclude_id.parse().unwrap_or(0);
  let exclude_hwnd = HWND(exclude_hwnd_val as *mut _);
  let vdm = create_virtual_desktop_manager();

  let mut log: Vec<String> = Vec::new();
  log.push(format!(
    "scanning Z-order (exclude={exclude_id}, vdm={})",
    vdm.is_some()
  ));

  unsafe {
    let mut hwnd = GetTopWindow(None).unwrap_or_default();
    let mut picked: Option<HWND> = None;
    while !hwnd.is_invalid() {
      let next = GetWindow(hwnd, GW_HWNDNEXT).unwrap_or_default();

      let verdict = classify_switchable(hwnd, exclude_hwnd, vdm.as_ref());
      log.push(format!("  {verdict}"));

      if picked.is_none() && verdict.ok {
        picked = Some(hwnd);
        // Don't break — keep logging so the whole near-top of the Z-order is
        // visible in the trace. The switch list is small enough (< ~40 tops).
      }
      hwnd = next;
    }

    let (ok, picked_id) = if let Some(h) = picked {
      if IsIconic(h).as_bool() {
        let _ = ShowWindow(h, SW_RESTORE);
      }
      let focused = SetForegroundWindow(h).as_bool();
      log.push(format!(
        "picked hwnd={} SetForegroundWindow={focused}",
        h.0 as isize
      ));
      (focused, Some(h.0 as isize))
    } else {
      log.push("no candidate found".to_string());
      (false, None)
    };

    for line in &log {
      diag_log(&format!("[focus_topmost] {line}"));
    }

    Ok(FocusTopmostResult {
      ok,
      picked_hwnd: picked_id.map(|v| v.to_string()),
      log,
    })
  }
}

struct SwitchVerdict {
  hwnd: isize,
  ok: bool,
  reason: &'static str,
  title: String,
  rect: (i32, i32, i32, i32),
}

impl std::fmt::Display for SwitchVerdict {
  fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
    write!(
      f,
      "hwnd={} ok={} reason={} rect=({},{},{},{}) title={:?}",
      self.hwnd,
      self.ok,
      self.reason,
      self.rect.0,
      self.rect.1,
      self.rect.2,
      self.rect.3,
      self.title
    )
  }
}

unsafe fn classify_switchable(
  hwnd: HWND,
  exclude: HWND,
  vdm: Option<&IVirtualDesktopManager>,
) -> SwitchVerdict {
  let title = window_title(hwnd);
  let rect = window_rect_tuple(hwnd);
  let mut v = SwitchVerdict {
    hwnd: hwnd.0 as isize,
    ok: false,
    reason: "pass",
    title,
    rect,
  };

  if hwnd.0 == exclude.0 {
    v.reason = "excluded";
    return v;
  }
  if !IsWindowVisible(hwnd).as_bool() {
    v.reason = "not-visible";
    return v;
  }
  if let Ok(owner) = GetWindow(hwnd, GW_OWNER) {
    if !owner.is_invalid() {
      v.reason = "owned";
      return v;
    }
  }
  let ex_style = GetWindowLongW(hwnd, GWL_EXSTYLE);
  if (ex_style as u32 & WS_EX_TOOLWINDOW.0) != 0 {
    v.reason = "tool-window";
    return v;
  }
  if GetWindowTextLengthW(hwnd) <= 0 {
    v.reason = "no-title";
    return v;
  }
  if get_cloak_state(hwnd) != 0 {
    v.reason = "cloaked";
    return v;
  }
  // Width/height sanity: a zero-area window can't be what the user meant.
  let (l, t, r, b) = rect;
  if r - l < 1 || b - t < 1 {
    v.reason = "zero-size";
    return v;
  }
  // The key AHK-killer: MonitorFromWindow with MONITOR_DEFAULTTONULL returns
  // null when the window's rect doesn't intersect any monitor. AHK helper
  // GUIs sit at (-32000,-32000) exactly for this reason — invisible to the
  // user. Weed them out here.
  let monitor = MonitorFromWindow(hwnd, MONITOR_DEFAULTTONULL);
  if monitor.is_invalid() {
    v.reason = "offscreen";
    return v;
  }
  if let Some(vdm) = vdm {
    match vdm.IsWindowOnCurrentVirtualDesktop(hwnd) {
      Ok(b) if !b.as_bool() => {
        v.reason = "other-desktop";
        return v;
      }
      _ => {}
    }
  }
  v.ok = true;
  v
}

unsafe fn window_title(hwnd: HWND) -> String {
  let len = GetWindowTextLengthW(hwnd);
  if len <= 0 {
    return String::new();
  }
  let mut buf = vec![0u16; (len as usize) + 1];
  let copied = GetWindowTextW(hwnd, &mut buf);
  if copied <= 0 {
    return String::new();
  }
  String::from_utf16_lossy(&buf[..copied as usize])
}

unsafe fn window_rect_tuple(hwnd: HWND) -> (i32, i32, i32, i32) {
  let mut rect = RECT::default();
  if GetWindowRect(hwnd, &mut rect).is_ok() {
    (rect.left, rect.top, rect.right, rect.bottom)
  } else {
    (0, 0, 0, 0)
  }
}

/// Resolve an HWND (as decimal string) to a `NativeWindow` descriptor so
/// callers can log titles/process names next to raw handles. Returns `None`
/// when the HWND is dead or otherwise refuses to answer `GetWindowThreadProcessId`
/// — i.e. the window no longer exists.
pub fn describe_window(id: &str) -> napi::Result<Option<NativeWindow>> {
  let hwnd_val: isize = id
    .parse()
    .map_err(|_| napi::Error::from_reason(format!("invalid window id: {id}")))?;
  let hwnd = HWND(hwnd_val as *mut _);

  unsafe {
    let mut pid: u32 = 0;
    GetWindowThreadProcessId(hwnd, Some(&mut pid));
    if pid == 0 {
      return Ok(None);
    }
    let title = window_title(hwnd);
    let (process_name, executable_path) = get_process_info(pid);
    Ok(Some(NativeWindow {
      id: id.to_string(),
      pid,
      title,
      process_name,
      executable_path,
      bundle_id: None,
    }))
  }
}

/// Extract the icon shown in the taskbar / Alt-Tab strip for a given HWND.
///
/// Why source from the window and not the exe:
///   - UWP apps (Windows Settings, Calculator, etc.) all run under
///     `ApplicationFrameHost.exe`. The host's embedded icon is a generic
///     "app frame" glyph — the real app icon is set on the HWND.
///   - Edge PWAs (Inbox, Outlook, Todoist, etc.) all run under `msedge.exe`.
///     Each PWA window carries its own icon via `WM_SETICON`.
///   - Electron apps launched from a shared `electron.exe` (dev mode, or a
///     distribution that reuses the Electron launcher) share the exe icon
///     but set per-app icons on their windows.
///
/// Source precedence, in order:
///   1. `WM_GETICON(ICON_BIG)` — high-DPI icon set by the app
///   2. `WM_GETICON(ICON_SMALL2)` — Windows' auto-scaled small icon
///   3. `WM_GETICON(ICON_SMALL)` — legacy small icon
///   4. `GetClassLongPtr(GCL_HICON / GCL_HICONSM)` — class-registered icons
///
/// Returns `None` if none of the above yield a usable HICON. The caller
/// (TypeScript side) then falls back to the exe-based icon resolver.
pub fn get_window_icon(id: &str) -> napi::Result<Option<WindowIcon>> {
  let hwnd_val: isize = id
    .parse()
    .map_err(|_| napi::Error::from_reason(format!("invalid window id: {id}")))?;
  let hwnd = HWND(hwnd_val as *mut _);

  unsafe {
    // UWP host special-case: the outer ApplicationFrameHost HWND returns a
    // generic "app frame" glyph via WM_GETICON — not what the user sees in
    // the taskbar. The real icon lives on the hosted CoreWindow (in the
    // actual UWP app's process). Try it directly and, if it doesn't expose
    // an icon either (common — UWP doesn't call WM_SETICON), return None
    // so the TS-side exe fallback runs against the now-retargeted UWP exe
    // (e.g. `SystemSettings.exe`), which the shell resolves to the correct
    // package icon.
    if is_application_frame_host(hwnd) {
      let Some(core) = find_uwp_core_window(hwnd) else {
        return Ok(None);
      };
      let Some(hicon) = find_window_icon(core) else {
        return Ok(None);
      };
      return hicon_to_bgra(hicon);
    }

    let Some(hicon) = find_window_icon(hwnd) else {
      return Ok(None);
    };
    hicon_to_bgra(hicon)
  }
}

/// Extract the icon at `icon_index` from a file on disk (.exe / .dll /
/// .ico / .lnk). Uses `ExtractIconExW`, the same API Explorer-class
/// consumers use for shortcut `IconLocation` resolution. Returns None if
/// the path doesn't expose an icon at that index — callers on the TS
/// side then fall through to their lucide fallback.
///
/// Why this exists alongside Electron's `app.getFileIcon`: the Electron
/// path routes through `SHGetFileInfo` whose per-size icon cache is
/// sparse for installer-shipped shortcuts (AdGuard, and similar
/// MSI-packaged apps). `ExtractIconExW` pulls the resource directly from
/// the file, bypassing that cache entirely.
pub fn get_file_icon(path: &str, icon_index: i32) -> napi::Result<Option<WindowIcon>> {
  use windows::core::PCWSTR;
  use windows::Win32::UI::Shell::ExtractIconExW;
  use windows::Win32::UI::WindowsAndMessaging::DestroyIcon;

  let wide: Vec<u16> = path.encode_utf16().chain(std::iter::once(0)).collect();
  unsafe {
    let mut large: [HICON; 1] = [HICON::default()];
    let mut small: [HICON; 1] = [HICON::default()];
    let count = ExtractIconExW(
      PCWSTR(wide.as_ptr()),
      icon_index,
      Some(large.as_mut_ptr()),
      Some(small.as_mut_ptr()),
      1,
    );

    // `0xFFFFFFFF` signals "no icons" and anything less than 1 means none
    // were extracted for our slot. Check the HICONs themselves because
    // ExtractIconExW can return a non-zero count while still leaving the
    // large slot null for files that only have small-size icons.
    let hicon = if count >= 1 && !large[0].is_invalid() {
      large[0]
    } else if !small[0].is_invalid() {
      small[0]
    } else {
      // Clean up whatever did come back (unlikely but cheap).
      if !large[0].is_invalid() {
        let _ = DestroyIcon(large[0]);
      }
      if !small[0].is_invalid() {
        let _ = DestroyIcon(small[0]);
      }
      return Ok(None);
    };

    // We own HICONs handed back by ExtractIconExW and MUST destroy them —
    // unlike `find_window_icon`'s WM_GETICON path which borrows the
    // taskbar icon from the target window.
    let result = hicon_to_bgra(hicon);
    let _ = DestroyIcon(large[0]);
    if !small[0].is_invalid() && small[0] != large[0] {
      let _ = DestroyIcon(small[0]);
    }
    result
  }
}

/// Walk icon sources in descending quality until we get a non-null HICON.
///
/// We do not own the returned HICON — `WM_GETICON` and `GetClassLongPtr`
/// both hand back the existing window/class icon. Destroying it would strip
/// the app's taskbar icon.
unsafe fn find_window_icon(hwnd: HWND) -> Option<HICON> {
  // SendMessageTimeoutW guards against hung target message pumps — 200 ms is
  // well above the typical <1 ms icon response but catches genuinely stuck
  // windows before the caller's search debounce expires.
  for &icon_type in &[ICON_BIG, ICON_SMALL2, ICON_SMALL] {
    let mut result: usize = 0;
    let _ = SendMessageTimeoutW(
      hwnd,
      WM_GETICON,
      WPARAM(icon_type as usize),
      LPARAM(0),
      SMTO_ABORTIFHUNG,
      200,
      Some(&mut result as *mut usize),
    );
    if result != 0 {
      return Some(HICON(result as *mut _));
    }
  }

  for &class_idx in &[GCL_HICON, GCL_HICONSM] {
    let h = GetClassLongPtrW(hwnd, class_idx);
    if h != 0 {
      return Some(HICON(h as *mut _));
    }
  }

  None
}

/// Render an HICON into a freshly-allocated 32bpp top-down DIB and return
/// its BGRA bytes. Relies on `DrawIconEx(..., DI_NORMAL)` to composite
/// mask-based and 32bpp-with-alpha icons into the destination surface with
/// correct per-pixel alpha. For ancient 1bpp icons whose alpha channel ends
/// up all-zero we synthesise alpha from the rendered pixels as a last resort.
unsafe fn hicon_to_bgra(hicon: HICON) -> napi::Result<Option<WindowIcon>> {
  let mut info = ICONINFO::default();
  if GetIconInfo(hicon, &mut info).is_err() {
    return Ok(None);
  }
  let color_bmp = info.hbmColor;
  let mask_bmp = info.hbmMask;

  // Icon dimensions live on the color bitmap when present. For monochrome
  // cursors (no color plane) the mask is 2× tall (AND above XOR) — halve it.
  let mut bm = BITMAP::default();
  let (width, height) = if !color_bmp.is_invalid() {
    let ok = GetObjectW(
      HGDIOBJ(color_bmp.0),
      std::mem::size_of::<BITMAP>() as i32,
      Some(&mut bm as *mut _ as *mut c_void),
    );
    if ok == 0 {
      cleanup_icon_bitmaps(color_bmp, mask_bmp);
      return Ok(None);
    }
    (bm.bmWidth as u32, bm.bmHeight as u32)
  } else if !mask_bmp.is_invalid() {
    let ok = GetObjectW(
      HGDIOBJ(mask_bmp.0),
      std::mem::size_of::<BITMAP>() as i32,
      Some(&mut bm as *mut _ as *mut c_void),
    );
    if ok == 0 {
      cleanup_icon_bitmaps(color_bmp, mask_bmp);
      return Ok(None);
    }
    (bm.bmWidth as u32, (bm.bmHeight / 2) as u32)
  } else {
    return Ok(None);
  };

  // Sanity bound — avoid allocating megabytes for a corrupt icon handle.
  if width == 0 || height == 0 || width > 512 || height > 512 {
    cleanup_icon_bitmaps(color_bmp, mask_bmp);
    return Ok(None);
  }

  let screen_dc = GetDC(None);
  let mem_dc = CreateCompatibleDC(screen_dc);

  let mut bmi: BITMAPINFO = std::mem::zeroed();
  bmi.bmiHeader.biSize = std::mem::size_of::<BITMAPINFOHEADER>() as u32;
  bmi.bmiHeader.biWidth = width as i32;
  bmi.bmiHeader.biHeight = -(height as i32); // negative = top-down rows
  bmi.bmiHeader.biPlanes = 1;
  bmi.bmiHeader.biBitCount = 32;
  bmi.bmiHeader.biCompression = BI_RGB.0;

  let mut bits_ptr: *mut c_void = std::ptr::null_mut();
  let dib = CreateDIBSection(
    mem_dc,
    &bmi,
    DIB_RGB_COLORS,
    &mut bits_ptr,
    None,
    0,
  );
  let Ok(dib) = dib else {
    let _ = DeleteDC(mem_dc);
    ReleaseDC(None, screen_dc);
    cleanup_icon_bitmaps(color_bmp, mask_bmp);
    return Ok(None);
  };
  if dib.is_invalid() || bits_ptr.is_null() {
    let _ = DeleteDC(mem_dc);
    ReleaseDC(None, screen_dc);
    cleanup_icon_bitmaps(color_bmp, mask_bmp);
    return Ok(None);
  }

  let old_obj = SelectObject(mem_dc, HGDIOBJ(dib.0));

  let _ = DrawIconEx(
    mem_dc,
    0,
    0,
    hicon,
    width as i32,
    height as i32,
    0,
    None,
    DI_NORMAL,
  );

  let byte_count = (width as usize) * (height as usize) * 4;
  let mut bgra = vec![0u8; byte_count];
  std::ptr::copy_nonoverlapping(bits_ptr as *const u8, bgra.as_mut_ptr(), byte_count);

  SelectObject(mem_dc, old_obj);
  let _ = DeleteObject(HGDIOBJ(dib.0));
  let _ = DeleteDC(mem_dc);
  ReleaseDC(None, screen_dc);
  cleanup_icon_bitmaps(color_bmp, mask_bmp);

  // Safety net for legacy 1bpp icons whose alpha ends up all-zero after
  // DrawIconEx: any pixel with non-black RGB is almost certainly meant to
  // be opaque. Modern 32bpp icons never hit this branch.
  let any_alpha = bgra.chunks(4).any(|px| px[3] != 0);
  if !any_alpha {
    for px in bgra.chunks_mut(4) {
      if px[0] != 0 || px[1] != 0 || px[2] != 0 {
        px[3] = 255;
      }
    }
  }

  Ok(Some(WindowIcon {
    width,
    height,
    bgra: bgra.into(),
  }))
}

unsafe fn cleanup_icon_bitmaps(color: HBITMAP, mask: HBITMAP) {
  if !color.is_invalid() {
    let _ = DeleteObject(HGDIOBJ(color.0));
  }
  if !mask.is_invalid() {
    let _ = DeleteObject(HGDIOBJ(mask.0));
  }
}

/// Check whether the given HWND lives on the currently-active virtual desktop.
///
/// Used to guard focus-restore on palette dismiss: if the user switched
/// desktops while the palette was open, the remembered HWND may point to a
/// window on a different desktop, and calling `SetForegroundWindow` on it
/// would yank the user back to that desktop.
///
/// Returns `true` when we can't determine desktop membership (missing VDM,
/// query error, invalid HWND) — we'd rather attempt the focus and risk a
/// desktop jump than silently drop the restore in cases that might be fine.
pub fn is_window_on_current_desktop(id: &str) -> napi::Result<bool> {
  let hwnd_val: isize = id
    .parse()
    .map_err(|_| napi::Error::from_reason(format!("invalid window id: {id}")))?;
  let hwnd = HWND(hwnd_val as *mut _);

  let Some(vdm) = create_virtual_desktop_manager() else {
    return Ok(true);
  };

  unsafe {
    match vdm.IsWindowOnCurrentVirtualDesktop(hwnd) {
      Ok(b) => Ok(b.as_bool()),
      Err(_) => Ok(true),
    }
  }
}

/// Zero-based index of the currently active virtual desktop. Uses the
/// `winvd` wrapper around Windows 11's undocumented
/// `IVirtualDesktopManagerInternal` COM interface — same dependency the
/// keyboard-remap module uses for workspace switching. On failure (older
/// Windows 10 builds or COM hiccups) returns 0, which degrades the tray
/// icon to "desktop 1" rather than crashing the poll loop.
pub fn get_current_desktop_number() -> napi::Result<u32> {
  match winvd::get_current_desktop() {
    Ok(d) => match d.get_index() {
      Ok(idx) => Ok(idx),
      Err(_) => Ok(0),
    },
    Err(_) => Ok(0),
  }
}
