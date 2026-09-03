//! macOS: the Accessibility plumbing shared by the rule actions that have
//! to reach into the frontmost window (`move_to_workspace`,
//! `close_window`).
//!
//! AX hands back +1-retained CFTypes, so every element travels in an
//! [`AXGuard`] that releases on drop. A copy stays valid independently of
//! the element it came from — dropping the application element doesn't
//! invalidate a window copied out of it.
//!
//! Every call here is IPC into another process. Callers run on a detached
//! thread for that reason; the messaging timeout below is the second half
//! of the same defence (a wedged app answers nothing, ever).

use core_foundation::base::TCFType;
use core_foundation::string::CFString;
use core_foundation_sys::base::{CFRelease, CFTypeRef};
use core_foundation_sys::string::CFStringRef;
use core_graphics::geometry::{CGPoint, CGRect, CGSize};
use std::os::raw::c_void;
use std::ptr;

// Match the type alias already in use by `native/src/macos.rs` (the window
// switcher's AX surface) so the linker sees one consistent FFI signature
// for `AXUIElementCopyAttributeValue`.
type AXUIElementRef = *mut c_void;
type AXValueRef = *const c_void;
type AXError = i32;
const AX_ERROR_SUCCESS: AXError = 0;

// AXValueType values from AXValue.h.
const AX_VALUE_CG_POINT_TYPE: u32 = 1;
const AX_VALUE_CG_SIZE_TYPE: u32 = 2;

/// Cap on a single AX round-trip, so a hung frontmost app can't park the
/// worker thread that's mid-sequence behind it.
const AX_MESSAGING_TIMEOUT_SECS: f32 = 0.25;

#[link(name = "ApplicationServices", kind = "framework")]
extern "C" {
    fn AXUIElementCreateSystemWide() -> AXUIElementRef;
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
    fn AXUIElementSetMessagingTimeout(element: AXUIElementRef, timeout_in_seconds: f32) -> AXError;
    fn AXValueGetValue(value: AXValueRef, the_type: u32, value_ptr: *mut c_void) -> bool;
}

#[link(name = "CoreFoundation", kind = "framework")]
extern "C" {
    static kCFBooleanTrue: CFTypeRef;
    static kCFBooleanFalse: CFTypeRef;
}

/// An owned AX reference — element or value. CFReleases on drop.
pub(super) struct AXGuard(AXUIElementRef);

impl Drop for AXGuard {
    fn drop(&mut self) {
        if !self.0.is_null() {
            unsafe { CFRelease(self.0 as CFTypeRef) }
        }
    }
}

/// The frontmost application's focused window, or `None` when nothing is
/// focused, the app publishes no AX tree, or Accessibility isn't granted.
pub(super) fn focused_window() -> Option<AXGuard> {
    attribute(&focused_application()?, "AXFocusedWindow")
}

/// The frontmost application element. Separate from [`focused_window`] so
/// callers can fall back to `AXMainWindow` when an app leaves
/// `AXFocusedWindow` unset.
pub(super) fn focused_application() -> Option<AXGuard> {
    let system = unsafe { AXUIElementCreateSystemWide() };
    if system.is_null() {
        return None;
    }
    let system = AXGuard(system);
    set_messaging_timeout(&system);

    let app = attribute(&system, "AXFocusedApplication")?;
    set_messaging_timeout(&app);
    Some(app)
}

/// Copy `attr` off `el`. `None` when the attribute isn't published — a
/// fullscreen window has no `AXCloseButton`, a chromeless one has no
/// title-bar buttons at all — or the owning app didn't answer in time.
pub(super) fn attribute(el: &AXGuard, attr: &str) -> Option<AXGuard> {
    let key = CFString::new(attr);
    let mut out: CFTypeRef = ptr::null();
    let err = unsafe { AXUIElementCopyAttributeValue(el.0, key.as_concrete_TypeRef(), &mut out) };
    if err != AX_ERROR_SUCCESS || out.is_null() {
        return None;
    }
    // Reinterpret as `*mut` — AX returns CFTypeRef (*const) but downstream
    // AX calls take `*mut c_void` per the type alias we match. CF doesn't
    // distinguish const-ness at the ABI level.
    Some(AXGuard(out as *mut c_void))
}

/// True when `attr` is a CFBoolean that reads true. CFBoolean values are
/// process-wide singletons, so pointer identity is the whole comparison.
pub(super) fn attribute_is_true(el: &AXGuard, attr: &str) -> bool {
    let Some(value) = attribute(el, attr) else {
        return false;
    };
    unsafe { value.0 as CFTypeRef == kCFBooleanTrue }
}

/// Write a boolean attribute (`AXFullScreen`, …). `false` means AX
/// refused — usually because the window doesn't publish that attribute as
/// settable.
pub(super) fn set_bool_attribute(el: &AXGuard, attr: &str, value: bool) -> bool {
    let key = CFString::new(attr);
    let boolean = unsafe {
        if value {
            kCFBooleanTrue
        } else {
            kCFBooleanFalse
        }
    };
    let err = unsafe { AXUIElementSetAttributeValue(el.0, key.as_concrete_TypeRef(), boolean) };
    err == AX_ERROR_SUCCESS
}

/// Perform a named action (`AXPress`, `AXRaise`, …) on an element.
pub(super) fn perform(el: &AXGuard, action: &str) -> bool {
    let name = CFString::new(action);
    let err = unsafe { AXUIElementPerformAction(el.0, name.as_concrete_TypeRef()) };
    err == AX_ERROR_SUCCESS
}

/// Screen-coordinate frame of an element, read from `AXPosition` +
/// `AXSize`. Suitable for `CGEventPost` coordinates directly.
pub(super) fn frame(el: &AXGuard) -> Option<CGRect> {
    let position = attribute(el, "AXPosition")?;
    let size = attribute(el, "AXSize")?;

    let mut origin = CGPoint { x: 0.0, y: 0.0 };
    let mut dims = CGSize {
        width: 0.0,
        height: 0.0,
    };
    unsafe {
        if !AXValueGetValue(
            position.0 as AXValueRef,
            AX_VALUE_CG_POINT_TYPE,
            &mut origin as *mut CGPoint as *mut c_void,
        ) {
            return None;
        }
        if !AXValueGetValue(
            size.0 as AXValueRef,
            AX_VALUE_CG_SIZE_TYPE,
            &mut dims as *mut CGSize as *mut c_void,
        ) {
            return None;
        }
    }

    Some(CGRect { origin, size: dims })
}

fn set_messaging_timeout(el: &AXGuard) {
    unsafe { AXUIElementSetMessagingTimeout(el.0, AX_MESSAGING_TIMEOUT_SECS) };
}
