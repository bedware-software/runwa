// macOS window enumeration + focus.
//
// Two listing paths, picked by the `current_desktop_only` flag:
//
//  1. Current Space only — uses CGWindowListCopyWindowInfo with
//     kCGWindowListOptionOnScreenOnly, the documented Core Graphics API. This
//     is how `yabai`, Rectangle, etc. get a fast, accurate window list scoped
//     to the active macOS Space.
//
//  2. All Spaces — uses the Accessibility (AX) API. AX queries each process's
//     own window list (via `AXUIElementCopyAttributeValue` on `AXWindows`) so
//     it sees windows on every Space without relying on private CGS SPIs. The
//     same approach Hammerspoon / yabai / Rectangle use. Requires the user
//     to grant Accessibility permission (System Settings → Privacy & Security
//     → Accessibility); without it the AX calls return empty, which the TS
//     side detects via `is_accessibility_trusted()` and surfaces as a prompt.
//
// Two focus paths:
//
//  - CG-sourced ids ("{pid}:{win_number}") use osascript to activate the
//    owning process — the existing current-Space behavior.
//  - AX-sourced ids ("ax:{cache_key}") use AX directly: set kAXFrontmostAttribute
//    on the app element (brings it forward, switches Space if cross-Space),
//    then perform kAXRaiseAction on the window element (raises that specific
//    window within the app, rather than the app's frontmost window).

use crate::NativeWindow;
use core_foundation::base::TCFType;
use core_foundation::string::CFString;
use core_foundation_sys::array::{CFArrayGetCount, CFArrayGetValueAtIndex};
use core_foundation_sys::base::{CFRelease, CFTypeRef};
use core_foundation_sys::dictionary::{
  kCFTypeDictionaryKeyCallBacks, kCFTypeDictionaryValueCallBacks, CFDictionaryCreate,
  CFDictionaryGetValue, CFDictionaryRef,
};
use core_foundation_sys::number::{kCFNumberSInt64Type, CFNumberGetValue, CFNumberRef};
use core_foundation_sys::string::{
  kCFStringEncodingUTF8, CFStringGetCString, CFStringGetCStringPtr, CFStringGetLength,
  CFStringGetMaximumSizeForEncoding, CFStringRef,
};
use core_graphics::window::{
  kCGNullWindowID, kCGWindowListExcludeDesktopElements, kCGWindowListOptionOnScreenOnly,
  CGWindowListCopyWindowInfo,
};
use std::collections::{HashMap, HashSet};
use std::os::raw::{c_int, c_void};
use std::process::Command;
use std::sync::{LazyLock, Mutex};

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
  if current_desktop_only {
    // Current-Space via CGWindowList with OnScreenOnly — naturally omits
    // most helper surfaces because they're either off-screen or on higher
    // layers. `hide_system_windows` is effectively already applied there,
    // but we pass it through in case we want explicit filtering later.
    Ok(list_windows_current_space(hide_system_windows))
  } else {
    // All-Spaces via CGWindowList without OnScreenOnly — includes every
    // layer-0 surface in the window server, which on macOS is a lot more
    // than just user app windows. Respecting the toggle here is what the
    // user expects: on → we strip XPC services and zero-sized helpers;
    // off → raw list so power users can see everything.
    list_windows_all_spaces(hide_system_windows)
  }
}

// ─── Current-Space listing via Core Graphics ────────────────────────────────

fn list_windows_current_space(_hide_system_windows: bool) -> Vec<NativeWindow> {
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

unsafe fn cf_dict_get_f64(dict: CFDictionaryRef, key: CFStringRef) -> Option<f64> {
  let value = CFDictionaryGetValue(dict, key as *const _);
  if value.is_null() {
    return None;
  }
  let num = value as CFNumberRef;
  let mut out: f64 = 0.0;
  // kCFNumberFloat64Type = 6
  let ok = CFNumberGetValue(num, 6, &mut out as *mut f64 as *mut _);
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

// ─── All-Spaces listing via the Accessibility API ───────────────────────────
//
// We enumerate every GUI process (via CGWindowListCopyWindowInfo with no
// OnScreenOnly filter — that window list is one of the few cheap ways to
// get a complete PID set without NSWorkspace/objc2), then for each PID open
// an AXUIElement and read `AXWindows`. AX sees windows on every Space because
// it talks to the owning app's window list directly, not the compositor.
//
// Window refs are stored in a process-global cache so `focus_window` can
// retrieve and raise them by id. The cache is cleared on each enumeration to
// avoid retaining AXUIElementRefs for processes that have since exited.

type AXError = i32;
type AXUIElementRef = *mut c_void;

const K_AX_ERROR_SUCCESS: AXError = 0;

#[link(name = "ApplicationServices", kind = "framework")]
extern "C" {
  fn AXUIElementCreateApplication(pid: c_int) -> AXUIElementRef;
  fn AXUIElementCopyAttributeValue(
    element: AXUIElementRef,
    attribute: CFStringRef,
    value: *mut CFTypeRef,
  ) -> AXError;
  fn AXUIElementSetAttributeValue(
    element: AXUIElementRef,
    attribute: CFStringRef,
    value: CFTypeRef,
  ) -> AXError;
  fn AXUIElementPerformAction(element: AXUIElementRef, action: CFStringRef) -> AXError;
  fn AXIsProcessTrusted() -> u8;
  fn AXIsProcessTrustedWithOptions(options: CFDictionaryRef) -> u8;
  /// Private. Returns the CGWindowID of an AX window element. Title-based
  /// matching between CG and AX is unreliable for Chromium apps (Edge,
  /// Chrome, Arc, Brave) because they rename their windows asynchronously,
  /// so `kCGWindowName` and `AXTitle` drift out of sync. Matching by
  /// CGWindowID sidesteps that entirely — it's a stable window-server
  /// identity that both APIs agree on. Same trick Hammerspoon / Phoenix /
  /// yabai use. Private since ~10.7 but has been stable for over a decade.
  #[link_name = "_AXUIElementGetWindow"]
  fn ax_ui_element_get_window(elem: AXUIElementRef, out_wid: *mut u32) -> AXError;
}

#[link(name = "CoreFoundation", kind = "framework")]
extern "C" {
  static kCFBooleanTrue: CFTypeRef;
}

#[link(name = "CoreGraphics", kind = "framework")]
extern "C" {
  /// Public API — reports whether the current process has Screen Recording
  /// permission applied *right now*. This is the authoritative check: if it
  /// returns false, TCC hasn't propagated the grant to our process (stale
  /// signature, wrong identifier, app not relaunched since toggle), which
  /// is exactly the case that makes `kCGWindowName` come back empty.
  fn CGPreflightScreenCaptureAccess() -> u8;
  /// Public API — triggers the Screen Recording permission prompt if the
  /// user hasn't decided yet, and on current macOS also registers the app
  /// with TCC so that manually-added entries in System Settings actually
  /// bind to our identifier. On Sequoia, calling this at least once per
  /// process lifetime is the difference between "toggle is on in System
  /// Settings but `CGPreflightScreenCaptureAccess` returns false" and the
  /// permission actually taking effect.
  fn CGRequestScreenCaptureAccess() -> u8;
}

/// RAII wrapper around an owned AX reference — CFReleases on drop. AX
/// elements are CFTypes, so the release call is the same as for any Core
/// Foundation value. Marked Send so we can stash them in a `Mutex<HashMap>`
/// (napi-rs calls run on the Node main thread; AX itself is safe to read
/// from any thread as long as calls aren't interleaved for the same element).
struct OwnedAxRef(AXUIElementRef);

impl Drop for OwnedAxRef {
  fn drop(&mut self) {
    if !self.0.is_null() {
      unsafe { CFRelease(self.0 as CFTypeRef) };
    }
  }
}

unsafe impl Send for OwnedAxRef {}

struct CachedAxWindow {
  pid: u32,
  app: OwnedAxRef,
  window: OwnedAxRef,
}

static AX_CACHE: LazyLock<Mutex<HashMap<String, CachedAxWindow>>> =
  LazyLock::new(|| Mutex::new(HashMap::new()));



/// Copy an AX attribute into an owned CFTypeRef (+1 retain). Returns `None`
/// when the attribute is absent, not set, or the process doesn't grant
/// permission — all "nothing to see here" cases for our purposes.
unsafe fn ax_copy_attribute(
  elem: AXUIElementRef,
  attribute: &CFString,
) -> Option<CFTypeRef> {
  let mut out: CFTypeRef = std::ptr::null();
  let err = AXUIElementCopyAttributeValue(
    elem,
    attribute.as_concrete_TypeRef() as CFStringRef,
    &mut out as *mut CFTypeRef,
  );
  if err != K_AX_ERROR_SUCCESS || out.is_null() {
    return None;
  }
  Some(out)
}

fn list_windows_all_spaces(hide_system_windows: bool) -> napi::Result<Vec<NativeWindow>> {
  // Why CGWindowList here instead of AX:
  //
  // AX's `AXWindows` attribute on modern macOS only reliably returns windows
  // the app is currently rendering on the active Space. Backgrounded apps
  // (which includes every app whose windows live on *another* Space) return
  // `kAXErrorCannotComplete` instead of their window list — that's the root
  // cause of the "only 2 windows found" result we were seeing.
  //
  // CGWindowList, by contrast, talks directly to WindowServer's window table,
  // which tracks every window the window server knows about regardless of
  // which Space is active. Combined with `kCGWindowListExcludeDesktopElements`
  // (no `OnScreenOnly`) we get: every layer-0 window across every Space.
  //
  // Titles come from `kCGWindowName`, which requires Screen Recording
  // permission — the user has already granted that, and the TS side falls
  // back to process name when it's missing anyway.
  //
  // Focus: windows enumerated here carry `{pid}:{win_number}` ids that the
  // existing osascript-activate-process path in `focus_window` handles. That
  // activation is coarser than precise per-window raise (it brings the app's
  // frontmost window forward, not necessarily the one the user clicked), but
  // macOS auto-switches Spaces as part of activation, so the cross-Space
  // promise still holds.

  // Drop any AX cache entries from prior calls — the cache only matters
  // for the future AX-listing path; harmless to leave, but we clear on
  // every enumeration to avoid retaining refs to exited processes.
  AX_CACHE.lock().expect("AX_CACHE poisoned").clear();

  unsafe {
    let options = kCGWindowListExcludeDesktopElements;
    let array_ref = CGWindowListCopyWindowInfo(options, kCGNullWindowID);
    if array_ref.is_null() {
      return Ok(Vec::new());
    }

    let count = CFArrayGetCount(array_ref);
    let key_layer = CFString::from_static_string("kCGWindowLayer");
    let key_number = CFString::from_static_string("kCGWindowNumber");
    let key_name = CFString::from_static_string("kCGWindowName");
    let key_owner_pid = CFString::from_static_string("kCGWindowOwnerPID");
    let key_owner_name = CFString::from_static_string("kCGWindowOwnerName");
    let key_bounds = CFString::from_static_string("kCGWindowBounds");
    let key_alpha = CFString::from_static_string("kCGWindowAlpha");
    let bounds_width = CFString::from_static_string("Width");
    let bounds_height = CFString::from_static_string("Height");

    let own_pid = std::process::id();
    let mut result: Vec<NativeWindow> = Vec::new();
    let mut pid_path_cache: HashMap<u32, Option<String>> = HashMap::new();

    // Pre-pass: find pids that own at least one non-blank-title window.
    // Chromium-family browsers (Edge, Chrome, Arc, Brave) register a
    // bunch of auxiliary layer-0 surfaces with user-sized frames but
    // blank `kCGWindowName` — those are phantoms that never correspond
    // to a real user-addressable window. Real browser windows, by
    // contrast, carry a page/tab title.
    //
    // Heuristic: for a pid with at least one real-titled window, treat
    // any *blank-title* window of that same pid as a phantom. For pids
    // whose windows all have blank titles (apps that legitimately don't
    // set window titles — some Electron apps, low-level frameworks),
    // we leave everything alone.
    let mut pids_with_titled_windows: HashSet<u32> = HashSet::new();
    if hide_system_windows {
      for i in 0..count {
        let dict_ptr = CFArrayGetValueAtIndex(array_ref, i) as CFDictionaryRef;
        if dict_ptr.is_null() {
          continue;
        }
        if cf_dict_get_i64(dict_ptr, key_layer.as_concrete_TypeRef()) != Some(0) {
          continue;
        }
        let pid_val = match cf_dict_get_i64(dict_ptr, key_owner_pid.as_concrete_TypeRef()) {
          Some(p) if p > 0 => p as u32,
          _ => continue,
        };
        let title_probe = cf_dict_get_string(dict_ptr, key_name.as_concrete_TypeRef())
          .unwrap_or_default();
        if !title_probe.trim().is_empty() {
          pids_with_titled_windows.insert(pid_val);
        }
      }
    }

    // Known macOS system-service processes that sit at layer 0 with
    // user-sized frames but aren't windows users would ever want to "switch
    // to" — they're credential prompts, security dialogs, thumbnail
    // generators, etc. that pop up transiently and own their own UI
    // surfaces. Bounds/alpha heuristics miss them because they render real
    // visible chrome. Process-name match on `kCGWindowOwnerName` is brittle
    // long-term, but macOS doesn't rename these much and we'd rather have
    // a short explicit list than an objc runtime dependency for
    // `NSApplicationActivationPolicy`.
    const SYSTEM_SERVICE_OWNERS: &[&str] = &[
      "AutoFill",
      "EndpointConnect",
      "CursorUIViewService",
      "WebThumbnailExtension",
      "WebThumbnailExte",
      "Universal Control",
      "UniversalControl",
      "loginwindow",
      "coreautha",
      "coreauthd",
      "CoreServicesUIAgent",
      "Open and Save Panel Service",
      "SecurityAgent",
      "NotificationCenter",
      "SystemUIServer",
      "WindowManager",
    ];

    // Minimum edge length (points) for a window to count as user-visible.
    // System helper windows routinely sit at layer 0 with sub-100pt frames
    // (AutoFill popovers, CursorUIViewService chrome, login-window overlays).
    // 100pt is the smallest a real user-facing window ever gets — below
    // that it's always a tool-palette or system surface nobody clicks to
    // focus. Pairs with the path filter below to clear out both ends of
    // the noise spectrum.
    const MIN_WINDOW_EDGE: f64 = 100.0;

    for i in 0..count {
      let dict_ptr = CFArrayGetValueAtIndex(array_ref, i) as CFDictionaryRef;
      if dict_ptr.is_null() {
        continue;
      }

      let layer = cf_dict_get_i64(dict_ptr, key_layer.as_concrete_TypeRef());
      if layer != Some(0) {
        continue;
      }

      let pid = match cf_dict_get_i64(dict_ptr, key_owner_pid.as_concrete_TypeRef()) {
        Some(p) if p > 0 => p as u32,
        _ => continue,
      };
      if pid == own_pid {
        continue;
      }

      let owner = cf_dict_get_string(dict_ptr, key_owner_name.as_concrete_TypeRef())
        .unwrap_or_default();
      let win_id = cf_dict_get_i64(dict_ptr, key_number.as_concrete_TypeRef()).unwrap_or(0);
      let title = cf_dict_get_string(dict_ptr, key_name.as_concrete_TypeRef())
        .unwrap_or_default();

      // Filters run only when the user wants system noise hidden (default).
      // With the toggle off we emit the raw window list verbatim — matches
      // the "Turn off to see every HWND on the desktop" promise in the
      // config description.
      if hide_system_windows {
        // Blocklist: known macOS system services that own user-sized
        // windows but aren't user-addressable targets. Size/alpha checks
        // don't catch them because they render real chrome.
        if SYSTEM_SERVICE_OWNERS.iter().any(|&s| s == owner.as_str()) {
          continue;
        }

        let bounds_ptr = CFDictionaryGetValue(
          dict_ptr,
          key_bounds.as_concrete_TypeRef() as *const _,
        ) as CFDictionaryRef;
        if !bounds_ptr.is_null() {
          let w = cf_dict_get_f64(bounds_ptr, bounds_width.as_concrete_TypeRef())
            .unwrap_or(0.0);
          let h = cf_dict_get_f64(bounds_ptr, bounds_height.as_concrete_TypeRef())
            .unwrap_or(0.0);
          if w < MIN_WINDOW_EDGE || h < MIN_WINDOW_EDGE {
            continue;
          }
        }

        let alpha = cf_dict_get_f64(dict_ptr, key_alpha.as_concrete_TypeRef())
          .unwrap_or(1.0);
        if alpha <= 0.01 {
          continue;
        }

        // Phantom-shell filter (see `pids_with_titled_windows` above).
        // An app with at least one real-titled window is "expected to
        // set titles" — any blank-title window of the same app is a
        // layer-0 shell surface. Edge gives us a textbook case: 2 real
        // windows with titles ("Shopping", "Inbox") plus 9 blank-title
        // phantoms. Apps with no real-titled windows anywhere (e.g.
        // Newbro, which just doesn't set titles) fall through untouched.
        if title.trim().is_empty() && pids_with_titled_windows.contains(&pid) {
          continue;
        }
      }

      let executable_path = pid_path_cache
        .entry(pid)
        .or_insert_with(|| pid_to_bundle_path(pid))
        .clone();

      result.push(NativeWindow {
        id: format!("{pid}:{win_id}"),
        pid,
        title,
        process_name: owner,
        executable_path,
        bundle_id: None,
      });
    }

    CFRelease(array_ref as CFTypeRef);

    Ok(result)
  }
}

pub fn is_accessibility_trusted() -> bool {
  unsafe { AXIsProcessTrusted() != 0 }
}

pub fn is_screen_recording_granted() -> bool {
  unsafe { CGPreflightScreenCaptureAccess() != 0 }
}

/// Fire-and-forget: triggers the macOS Screen Recording permission prompt
/// if the user hasn't decided yet, and ensures TCC binds the grant to the
/// current process. Safe to call repeatedly — a no-op once the grant is
/// either allowed or denied. Returns the immediate trusted state, which is
/// almost always `false` on the very first call because the prompt is
/// async; a restart is needed before the grant actually takes effect.
pub fn request_screen_recording_permission() -> bool {
  unsafe { CGRequestScreenCaptureAccess() != 0 }
}

/// Triggers the one-time Accessibility-permission prompt. Returns the current
/// trusted state. If false, the user must grant manually in System Settings
/// and restart the app — AX doesn't re-check permission on the fly.
pub fn request_accessibility_permission() -> bool {
  unsafe {
    let key = CFString::from_static_string("AXTrustedCheckOptionPrompt");
    let keys: [*const c_void; 1] = [key.as_concrete_TypeRef() as *const c_void];
    let values: [*const c_void; 1] = [kCFBooleanTrue as *const c_void];
    let dict = CFDictionaryCreate(
      std::ptr::null(),
      keys.as_ptr(),
      values.as_ptr(),
      1,
      &kCFTypeDictionaryKeyCallBacks,
      &kCFTypeDictionaryValueCallBacks,
    );
    let trusted = AXIsProcessTrustedWithOptions(dict) != 0;
    if !dict.is_null() {
      CFRelease(dict as CFTypeRef);
    }
    trusted
  }
}

// ─── Focus ──────────────────────────────────────────────────────────────────

pub fn focus_window(id: &str) -> napi::Result<bool> {
  // AX-prefixed ids exist for a future iteration that lists windows via AX
  // directly. Kept as a dispatch branch so the id format is stable.
  if let Some(key) = id.strip_prefix("ax:") {
    return Ok(focus_ax_window(key));
  }

  // CG-sourced id format: `{pid}:{cg_window_id}`. wid is the part AX and
  // CG both agree on, so we don't need any per-listing cache — parsing
  // the id is enough.
  let mut parts = id.splitn(2, ':');
  let pid: u32 = parts
    .next()
    .and_then(|s| s.parse().ok())
    .ok_or_else(|| napi::Error::from_reason(format!("invalid window id: {id}")))?;
  let wid: Option<u32> = parts.next().and_then(|s| s.parse().ok());

  // Detect whether activating this process will animate a Space switch.
  // If the app has any window on the currently-visible Space, activation
  // is instant — AXRaise can fire right after with no delay. If not,
  // we're about to cross Spaces and AXRaise during the animation will be
  // silently overridden by macOS's own mid-switch window promotion.
  let cross_space = !pid_has_onscreen_window(pid);

  // Step 1: activate the process via osascript. Brings the app forward
  // (switching Spaces if needed) AND wakes it up enough that AX queries
  // start answering — without activation first, AX returns
  // `kAXErrorCannotComplete` for any app not already on the current Space.
  let activated = osascript_activate_pid(pid)?;

  // Step 2: precise raise via AX, matching by CGWindowID (not title —
  // Chromium-family apps rename windows async so AXTitle and
  // kCGWindowName drift out of sync, but CGWindowID stays stable).
  if let Some(wid) = wid {
    if is_accessibility_trusted() {
      if cross_space {
        // Wait for the Space-switch animation + window-server reshuffle
        // to settle. AXRaise during the animation gets stomped by macOS's
        // mid-switch window promotion. 250ms covers the switch; retry
        // handles apps that do their own internal reordering on becoming
        // frontmost.
        let attempts: &[u64] = &[250, 150];
        for ms in attempts {
          std::thread::sleep(std::time::Duration::from_millis(*ms));
          if raise_ax_window_by_cg_id(pid, wid) {
            break;
          }
        }
      } else {
        // Same Space: raise immediately. Zero perceived latency.
        let _ = raise_ax_window_by_cg_id(pid, wid);
      }
    }
  }

  Ok(activated)
}

/// Locate the AX window whose CGWindowID matches `target_wid` in `pid`'s
/// AXWindows list, and raise it. Assumes the app is already foregrounded
/// (see `osascript_activate_pid`) so AX queries don't return
/// `kAXErrorCannotComplete`.
///
/// CGWindowID matching (via the private `_AXUIElementGetWindow`) is the
/// only reliable way to cross-reference CG and AX for Chromium-family
/// apps — their AX titles and CG titles drift out of sync because
/// Chromium renames windows asynchronously on tab switches. CGWindowID,
/// by contrast, is WindowServer's stable identity that both APIs agree
/// on.
fn raise_ax_window_by_cg_id(pid: u32, target_wid: u32) -> bool {
  let app = unsafe { AXUIElementCreateApplication(pid as c_int) };
  if app.is_null() {
    return false;
  }

  let attr_windows = CFString::from_static_string("AXWindows");
  let action_raise = CFString::from_static_string("AXRaise");

  let win_array_raw = match unsafe { ax_copy_attribute(app, &attr_windows) } {
    Some(v) => v,
    None => {
      unsafe { CFRelease(app as CFTypeRef) };
      return false;
    }
  };

  let arr = win_array_raw as core_foundation_sys::array::CFArrayRef;
  let count = unsafe { CFArrayGetCount(arr) };
  let mut raised = false;

  for i in 0..count {
    let win = unsafe { CFArrayGetValueAtIndex(arr, i) } as AXUIElementRef;
    if win.is_null() {
      continue;
    }
    let mut wid: u32 = 0;
    let err = unsafe { ax_ui_element_get_window(win, &mut wid) };
    if err != K_AX_ERROR_SUCCESS {
      continue;
    }
    if wid == target_wid {
      let raise_err = unsafe {
        AXUIElementPerformAction(
          win,
          action_raise.as_concrete_TypeRef() as CFStringRef,
        )
      };
      raised = raise_err == K_AX_ERROR_SUCCESS;
      break;
    }
  }

  unsafe { CFRelease(win_array_raw) };
  unsafe { CFRelease(app as CFTypeRef) };
  raised
}

/// True if `pid` owns at least one window that CGWindowList reports as
/// on-screen — a cheap "is this app on the current Space?" check. Used
/// to decide whether activating the process will trigger a Space-switch
/// animation (and therefore whether AXRaise needs to wait for it).
fn pid_has_onscreen_window(pid: u32) -> bool {
  unsafe {
    let options = kCGWindowListOptionOnScreenOnly | kCGWindowListExcludeDesktopElements;
    let arr = CGWindowListCopyWindowInfo(options, kCGNullWindowID);
    if arr.is_null() {
      return false;
    }
    let count = CFArrayGetCount(arr);
    let key_pid = CFString::from_static_string("kCGWindowOwnerPID");
    let mut found = false;
    for i in 0..count {
      let dict = CFArrayGetValueAtIndex(arr, i) as CFDictionaryRef;
      if dict.is_null() {
        continue;
      }
      if let Some(p) = cf_dict_get_i64(dict, key_pid.as_concrete_TypeRef()) {
        if p as u32 == pid {
          found = true;
          break;
        }
      }
    }
    CFRelease(arr as CFTypeRef);
    found
  }
}

/// Activate a process by PID via osascript — the same "set frontmost of
/// process X to true" logic the focus path has always used. Extracted so
/// both the old coarse-activate behavior and the new precise-raise path
/// share a single implementation.
fn osascript_activate_pid(pid: u32) -> napi::Result<bool> {
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

  Ok(
    output.status.success()
      && String::from_utf8_lossy(&output.stdout).trim() == "ok",
  )
}


fn focus_ax_window(cache_key_suffix: &str) -> bool {
  let id = format!("ax:{cache_key_suffix}");
  let cache = AX_CACHE.lock().expect("AX_CACHE poisoned");
  let Some(entry) = cache.get(&id) else {
    return false;
  };

  let attr_frontmost = CFString::from_static_string("AXFrontmost");
  let action_raise = CFString::from_static_string("AXRaise");

  // 1. Bring the owning app forward. Setting AXFrontmost on the app element
  //    works cross-Space: macOS auto-switches to whichever Space has the
  //    app's window. Without this step, AXRaise only reorders within the
  //    app's window list and the user never sees the change.
  unsafe {
    AXUIElementSetAttributeValue(
      entry.app.0,
      attr_frontmost.as_concrete_TypeRef() as CFStringRef,
      kCFBooleanTrue,
    );
  }

  // 2. Raise the specific window within the app. Without this, the app's
  //    most-recently-used window gets raised, not the one the user picked.
  let raise_err = unsafe {
    AXUIElementPerformAction(
      entry.window.0,
      action_raise.as_concrete_TypeRef() as CFStringRef,
    )
  };

  let _ = entry.pid; // kept for future per-pid NSRunningApplication fallback
  raise_err == K_AX_ERROR_SUCCESS
}
