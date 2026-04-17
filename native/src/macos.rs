// macOS window enumeration + focus.
//
// Two listing paths, picked by the `current_desktop_only` flag:
//
//  1. Current Space only — uses CGWindowListCopyWindowInfo with
//     kCGWindowListOptionOnScreenOnly, the documented Core Graphics API. This
//     is how `yabai`, Rectangle, etc. get a fast, accurate window list scoped
//     to the active macOS Space.
//
//  2. All Spaces — falls back to osascript / System Events, which returns
//     every window across every Space. Core Graphics has no public API for
//     "windows on another Space" short of the private CGS SPIs, so osascript
//     is the simplest portable option.
//
// Focus still uses osascript (`set frontmost of process whose unix id is X`)
// because activating a process by PID is a one-liner and works on both paths.
// Raising a specific window within that process requires the Accessibility
// API — a future iteration can upgrade this via objc2 crates.

use crate::NativeWindow;
use core_foundation::base::TCFType;
use core_foundation::string::CFString;
use core_foundation_sys::array::{CFArrayGetCount, CFArrayGetValueAtIndex};
use core_foundation_sys::base::{CFRelease, CFTypeRef};
use core_foundation_sys::dictionary::{CFDictionaryGetValue, CFDictionaryRef};
use core_foundation_sys::number::{kCFNumberSInt64Type, CFNumberGetValue, CFNumberRef};
use core_foundation_sys::string::{
  kCFStringEncodingUTF8, CFStringGetCString, CFStringGetCStringPtr, CFStringGetLength,
  CFStringGetMaximumSizeForEncoding, CFStringRef,
};
use core_graphics::window::{
  kCGNullWindowID, kCGWindowListExcludeDesktopElements, kCGWindowListOptionOnScreenOnly,
  CGWindowListCopyWindowInfo,
};
use std::collections::HashMap;
use std::os::raw::{c_int, c_void};
use std::process::Command;

// libproc is part of the macOS system library and links automatically.
// `proc_pidpath` writes the on-disk path of a running process's executable
// into a caller-supplied buffer — our only route from a CGWindowList PID
// back to a filesystem path Electron's `app.getFileIcon` can resolve.
extern "C" {
  fn proc_pidpath(pid: c_int, buffer: *mut c_void, buffersize: u32) -> c_int;
}

/// Resolve a PID to the enclosing `.app` bundle (e.g.
/// `/Applications/Finder.app`), falling back to the raw executable path when
/// the process isn't inside a bundle. Returns `None` when `proc_pidpath`
/// refuses (EPERM for some Apple internals, or the process has exited).
///
/// We walk up to the `.app` ancestor because Electron's `app.getFileIcon`
/// returns the Finder-style app icon for `Foo.app` but only the generic
/// binary icon for `Foo.app/Contents/MacOS/Foo`.
fn pid_to_bundle_path(pid: u32) -> Option<String> {
  const MAX_PATH: usize = 4096; // PROC_PIDPATHINFO_MAXSIZE
  let mut buf = vec![0u8; MAX_PATH];
  let ret = unsafe {
    proc_pidpath(
      pid as c_int,
      buf.as_mut_ptr() as *mut c_void,
      MAX_PATH as u32,
    )
  };
  if ret <= 0 {
    return None;
  }
  let exe_path = std::str::from_utf8(&buf[..ret as usize]).ok()?.to_string();
  Some(truncate_to_app_bundle(&exe_path))
}

fn truncate_to_app_bundle(exe_path: &str) -> String {
  // `rfind` picks the innermost `.app` ancestor, which is what we want when
  // an app embeds helper bundles (e.g. Electron's `Foo Helper.app` nested
  // under `Foo.app`). The helper's own icon is the right one for its windows.
  if let Some(idx) = exe_path.rfind(".app/") {
    let end = idx + ".app".len();
    return exe_path[..end].to_string();
  }
  exe_path.to_string()
}

pub fn list_windows(
  current_desktop_only: bool,
  hide_system_windows: bool,
) -> napi::Result<Vec<NativeWindow>> {
  // macOS equivalents of the Windows "cloaked shell surfaces" (Spotlight,
  // Control Center, Notification Center, etc.) never show up in the layer-0
  // CGWindowList or in `System Events`'s visible-process query, so the
  // `hide_system_windows` flag is a no-op here. It's accepted for parity
  // with the Windows signature.
  let _ = hide_system_windows;

  if current_desktop_only {
    Ok(list_windows_current_space())
  } else {
    list_windows_all_spaces()
  }
}

// ─── Current-Space listing via Core Graphics ────────────────────────────────

fn list_windows_current_space() -> Vec<NativeWindow> {
  unsafe {
    let options = kCGWindowListOptionOnScreenOnly | kCGWindowListExcludeDesktopElements;
    let array_ref = CGWindowListCopyWindowInfo(options, kCGNullWindowID);
    if array_ref.is_null() {
      return Vec::new();
    }

    let count = CFArrayGetCount(array_ref);

    // CFString keys matching Apple's kCG* string-literal constants.
    // (kCGWindowNumber's string value is literally "kCGWindowNumber", and so on.)
    let key_layer = CFString::from_static_string("kCGWindowLayer");
    let key_number = CFString::from_static_string("kCGWindowNumber");
    let key_name = CFString::from_static_string("kCGWindowName");
    let key_owner_pid = CFString::from_static_string("kCGWindowOwnerPID");
    let key_owner_name = CFString::from_static_string("kCGWindowOwnerName");

    let mut result = Vec::with_capacity(count as usize);
    // Multiple windows of the same app share a PID — cache per call so we
    // don't pay the proc_pidpath cost once per window (Finder alone can
    // emit 10+ rows on a busy desktop).
    let mut pid_path_cache: HashMap<u32, Option<String>> = HashMap::new();

    for i in 0..count {
      let dict_ptr = CFArrayGetValueAtIndex(array_ref, i) as CFDictionaryRef;
      if dict_ptr.is_null() {
        continue;
      }

      // Normal app windows are on layer 0. Menu bar, dock, status bar are higher layers.
      let layer = cf_dict_get_i64(dict_ptr, key_layer.as_concrete_TypeRef());
      if layer != Some(0) {
        continue;
      }

      // CGWindowListCopyWindowInfo only populates `kCGWindowName` when the
      // caller has Screen Recording permission. TCC grants to ad-hoc-signed
      // binaries (Electron.app under node_modules, electron-builder output
      // without a Developer ID signature) are brittle and silently ignored
      // more often than not. Rather than dropping every window to an empty
      // result list, let untitled windows through — the TS side falls back
      // to the process name so the user still gets app-level switching.
      let title = cf_dict_get_string(dict_ptr, key_name.as_concrete_TypeRef())
        .unwrap_or_default();

      let pid = match cf_dict_get_i64(dict_ptr, key_owner_pid.as_concrete_TypeRef()) {
        Some(p) if p > 0 => p as u32,
        _ => continue,
      };

      let owner = cf_dict_get_string(dict_ptr, key_owner_name.as_concrete_TypeRef())
        .unwrap_or_default();
      let win_id = cf_dict_get_i64(dict_ptr, key_number.as_concrete_TypeRef()).unwrap_or(0);

      let executable_path = pid_path_cache
        .entry(pid)
        .or_insert_with(|| pid_to_bundle_path(pid))
        .clone();

      result.push(NativeWindow {
        id: format!("{}:{}", pid, win_id),
        pid,
        title,
        process_name: owner,
        executable_path,
        bundle_id: None,
      });
    }

    // CGWindowListCopyWindowInfo is a "Copy" function — we own the array.
    CFRelease(array_ref as CFTypeRef);
    result
  }
}

unsafe fn cf_dict_get_i64(dict: CFDictionaryRef, key: CFStringRef) -> Option<i64> {
  let value = CFDictionaryGetValue(dict, key as *const _);
  if value.is_null() {
    return None;
  }
  let num = value as CFNumberRef;
  let mut out: i64 = 0;
  let ok = CFNumberGetValue(num, kCFNumberSInt64Type, &mut out as *mut i64 as *mut _);
  if ok {
    Some(out)
  } else {
    None
  }
}

unsafe fn cf_dict_get_string(dict: CFDictionaryRef, key: CFStringRef) -> Option<String> {
  let value = CFDictionaryGetValue(dict, key as *const _);
  if value.is_null() {
    return None;
  }
  cfstring_to_rust(value as CFStringRef)
}

unsafe fn cfstring_to_rust(s: CFStringRef) -> Option<String> {
  if s.is_null() {
    return None;
  }
  // Fast path: try to get a direct UTF-8 pointer (not always available).
  let fast = CFStringGetCStringPtr(s, kCFStringEncodingUTF8);
  if !fast.is_null() {
    return Some(
      std::ffi::CStr::from_ptr(fast)
        .to_string_lossy()
        .into_owned(),
    );
  }
  // Slow path: copy into a heap buffer.
  let len = CFStringGetLength(s);
  let max = CFStringGetMaximumSizeForEncoding(len, kCFStringEncodingUTF8) + 1;
  if max <= 0 {
    return Some(String::new());
  }
  let mut buf = vec![0i8; max as usize];
  // CFStringGetCString returns Boolean (c_uchar), not Rust bool — compare to 0.
  let ok = CFStringGetCString(s, buf.as_mut_ptr(), max, kCFStringEncodingUTF8);
  if ok == 0 {
    return None;
  }
  let nul = buf.iter().position(|&b| b == 0).unwrap_or(buf.len());
  let bytes: Vec<u8> = buf[..nul].iter().map(|&b| b as u8).collect();
  Some(String::from_utf8_lossy(&bytes).into_owned())
}

// ─── All-Spaces listing via osascript ───────────────────────────────────────
// This is slower (~80–200ms per call) but reaches windows on other Spaces,
// which the Core Graphics API can't do without private SPIs.

const LIST_ALL_SCRIPT: &str = r#"
set output to ""
tell application "System Events"
    set procList to every process whose background only is false
    repeat with p in procList
        try
            set pName to name of p
            set pPid to unix id of p
            set winList to every window of p
            repeat with w in winList
                try
                    set wName to name of w
                    set wId to 0
                    try
                        set wId to id of w
                    end try
                    if wName is not missing value and wName is not "" then
                        set output to output & pPid & tab & pName & tab & wId & tab & wName & linefeed
                    end if
                end try
            end repeat
        end try
    end repeat
end tell
return output
"#;

fn list_windows_all_spaces() -> napi::Result<Vec<NativeWindow>> {
  let output = Command::new("osascript")
    .args(["-e", LIST_ALL_SCRIPT])
    .output()
    .map_err(|e| napi::Error::from_reason(format!("osascript failed: {e}")))?;

  if !output.status.success() {
    return Ok(Vec::new());
  }

  let text = String::from_utf8_lossy(&output.stdout);
  let mut windows = Vec::new();
  let mut pid_path_cache: HashMap<u32, Option<String>> = HashMap::new();

  for line in text.lines() {
    let line = line.trim_end_matches('\r');
    if line.is_empty() {
      continue;
    }
    let parts: Vec<&str> = line.splitn(4, '\t').collect();
    if parts.len() < 4 {
      continue;
    }
    let pid: u32 = match parts[0].parse() {
      Ok(p) => p,
      Err(_) => continue,
    };
    let process_name = parts[1].to_string();
    let window_id = parts[2].to_string();
    let title = parts[3].to_string();

    let executable_path = pid_path_cache
      .entry(pid)
      .or_insert_with(|| pid_to_bundle_path(pid))
      .clone();

    windows.push(NativeWindow {
      id: format!("{}:{}", pid, window_id),
      pid,
      title,
      process_name,
      executable_path,
      bundle_id: None,
    });
  }

  Ok(windows)
}

// ─── Focus ──────────────────────────────────────────────────────────────────

pub fn focus_window(id: &str) -> napi::Result<bool> {
  let pid_str = id.split(':').next().unwrap_or("");
  let pid: u32 = pid_str
    .parse()
    .map_err(|_| napi::Error::from_reason(format!("invalid window id: {id}")))?;

  let script = format!(
    r#"tell application "System Events"
         try
             set targetProc to first process whose unix id is {pid}
             set frontmost of targetProc to true
             return "ok"
         on error
             return "err"
         end try
       end tell"#
  );

  let output = Command::new("osascript")
    .args(["-e", &script])
    .output()
    .map_err(|e| napi::Error::from_reason(format!("osascript failed: {e}")))?;

  let ok = output.status.success()
    && String::from_utf8_lossy(&output.stdout).trim() == "ok";
  Ok(ok)
}
