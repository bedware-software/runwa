//! macOS: move the active window to another Space via the title-bar-drag
//! trick.
//!
//! macOS has no public API for programmatically moving a window between
//! Spaces. SkyLight-based direct switching is incomplete on Sequoia+
//! (compositor pointer moves, WindowServer doesn't agree); yabai's fully
//! native approach needs a scripting addition with SIP partially
//! disabled. So we mimic what a user does by hand:
//!
//!   1. Query the frontmost window's frame via Accessibility.
//!   2. Synthesize LeftMouseDown at the title bar's center.
//!   3. Briefly wait so WindowServer registers a drag.
//!   4. Synthesize `Ctrl+N` — macOS's built-in "Switch to Desktop N".
//!   5. Wait for the space-switch animation to finish.
//!   6. Synthesize LeftMouseUp. Window drops at the same screen point on
//!      the new Space.
//!   7. Restore the cursor.
//!
//! Requirements:
//!   - Accessibility permission (already granted for the keyboard hook).
//!   - "Switch to Desktop N" shortcuts enabled in System Settings →
//!     Keyboard → Shortcuts → Mission Control.
//!
//! Caveats:
//!   - The cursor visibly jumps to the title bar and back.
//!   - Fullscreen windows, Stage Manager tiles, and borderless windows
//!     will misbehave or no-op.
//!   - The entire sequence takes ~600ms; it runs on a detached thread so
//!     the keyboard hook callback isn't blocked past its tap timeout.

use core_foundation::base::TCFType;
use core_foundation::string::CFString;
use core_foundation_sys::base::{CFRelease, CFTypeRef};
use core_graphics::event::{
    CGEvent, CGEventFlags, CGEventTapLocation, CGEventType, CGMouseButton, EventField,
};
use core_graphics::event_source::{CGEventSource, CGEventSourceStateID};
use core_graphics::geometry::{CGPoint, CGRect, CGSize};
use std::os::raw::c_void;
use std::ptr;
use std::thread;
use std::time::Duration;

use super::rules::{Modifier, NamedKey, SyntheticEvent};
use super::synth::INJECT_TAG;

// ---------------------------------------------------------------------------
// FFI — Accessibility + mouse warping. Both live in ApplicationServices,
// which is already linked via build.rs.

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

#[link(name = "ApplicationServices", kind = "framework")]
extern "C" {
    fn AXUIElementCreateSystemWide() -> AXUIElementRef;
    fn AXUIElementCopyAttributeValue(
        element: AXUIElementRef,
        attribute: core_foundation_sys::string::CFStringRef,
        value: *mut CFTypeRef,
    ) -> AXError;
    fn AXUIElementSetMessagingTimeout(
        element: AXUIElementRef,
        timeout_in_seconds: f32,
    ) -> AXError;
    fn AXValueGetValue(value: AXValueRef, the_type: u32, value_ptr: *mut c_void) -> bool;
    fn CGWarpMouseCursorPosition(new_cursor_position: CGPoint) -> i32;
    fn CGAssociateMouseAndMouseCursorPosition(connected: bool) -> i32;
}

// ---------------------------------------------------------------------------

pub fn move_active_window_to_workspace(n: u32) {
    if !(1..=9).contains(&n) {
        eprintln!("[keyboard-remap] move_to_workspace({n}) on macOS supports 1-9 only");
        return;
    }

    // Detach — the hook callback must return promptly or CGEventTap will
    // disable us via TapDisabledByTimeout. The sequence sleeps for ~600ms.
    thread::Builder::new()
        .name("runwa-move-to-workspace".into())
        .spawn(move || run_move_sequence(n))
        .map_err(|e| eprintln!("[keyboard-remap] move_to_workspace spawn failed: {e}"))
        .ok();
}

fn run_move_sequence(n: u32) {
    let Some(frame) = active_window_frame() else {
        eprintln!("[keyboard-remap] move_to_workspace: couldn't read frontmost window frame");
        return;
    };

    // Bail on windows so small that picking a point inside them could miss
    // the title bar entirely. Typical Finder-minimum is ~340×200.
    if frame.size.width < 120.0 || frame.size.height < 40.0 {
        eprintln!("[keyboard-remap] move_to_workspace: window too small to drag");
        return;
    }

    // Click in the gap between the close (red) and minimize (orange)
    // traffic-light buttons. The AX query gives us each button's actual
    // frame, so the midpoint is layout-independent — handles wider
    // spacing on newer macOS and apps that shift the chrome. Fall back
    // chain: close+minimize midpoint → just past close's right edge →
    // a fixed offset if neither AX button is exposed (borderless /
    // chromeless windows, dialogs).
    let close = active_window_button_frame("AXCloseButton");
    let minimize = active_window_button_frame("AXMinimizeButton");
    let target = match (close, minimize) {
        (Some(c), Some(m)) => CGPoint {
            x: (c.origin.x + c.size.width + m.origin.x) / 2.0,
            y: c.origin.y + c.size.height / 2.0,
        },
        (Some(c), None) => CGPoint {
            x: c.origin.x + c.size.width + 5.0,
            y: c.origin.y + c.size.height / 2.0,
        },
        _ => CGPoint {
            // ~24pt past the window's left edge — between close (~x=14) and
            // minimize (~x=34) on the standard macOS traffic-light layout.
            x: frame.origin.x + 24.0,
            y: frame.origin.y + 13.0,
        },
    };
    eprintln!(
        "[keyboard-remap] move_to_workspace({n}): frame=({:.0},{:.0}) {:.0}x{:.0}, click target=({:.0},{:.0})",
        frame.origin.x, frame.origin.y, frame.size.width, frame.size.height,
        target.x, target.y,
    );

    let Ok(source) = CGEventSource::new(CGEventSourceStateID::HIDSystemState) else {
        eprintln!("[keyboard-remap] move_to_workspace: CGEventSource::new failed");
        return;
    };

    // Save cursor — the drag path visibly moves it.
    let original = cursor_position();

    // 1. Warp the cursor explicitly so WindowServer's internal
    //    "cursor-over-widget" state is synced BEFORE the click. Posting
    //    a MouseDown with a position alone updates the cursor, but some
    //    macOS versions stamp the click against the cursor's previous
    //    position (race between cursor-update and click-handling in
    //    WindowServer), making the click arrive somewhere other than
    //    the title bar. CGAssociateMouseAndMouseCursorPosition(true)
    //    re-enables physical-mouse tracking which the warp disables.
    unsafe {
        CGWarpMouseCursorPosition(target);
        CGAssociateMouseAndMouseCursorPosition(true);
    }

    // 2. Sync WindowServer's hit-test state with a MouseMoved at target.
    //    Real HID drags always start with a move; Apple's own drag-engage
    //    heuristic looks for this. Without it, the subsequent MouseDown
    //    may be treated as a "click on an inactive region" rather than a
    //    drag start.
    post_mouse(&source, CGEventType::MouseMoved, target);
    thread::sleep(Duration::from_millis(100));

    // 3. Mouse down with full pressure. On Force Touch trackpads the
    //    pressure field governs the drag-engage threshold; 1.0 = fully
    //    pressed. Also sets clickState=1 inside `post_mouse_pressed`.
    post_mouse_pressed(&source, CGEventType::LeftMouseDown, target);
    thread::sleep(Duration::from_millis(50));
    post_mouse_pressed(&source, CGEventType::LeftMouseDragged, target);

    // 6. Switch Space via the system shortcut. The window follows because
    //    it's our active drag target.
    let digit = NamedKey::Alpha(b'0' + n as u8);
    super::macos::inject(
        &[
            SyntheticEvent::ModifierDown(Modifier::Ctrl),
            SyntheticEvent::KeyDown(digit),
            SyntheticEvent::KeyUp(digit),
            SyntheticEvent::ModifierUp(Modifier::Ctrl),
        ],
        CGEventFlags::empty(),
    );

    // 7. Wait for the animation. Sequoia's slide is ~400ms; 550ms gives
    //    headroom. Releasing earlier and the window snaps back.
    thread::sleep(Duration::from_millis(550));

    // 8. Drop the window on the new Space.
    post_mouse_pressed(&source, CGEventType::LeftMouseUp, target);

    // 9. Restore cursor. CGWarpMouseCursorPosition implicitly
    //    disassociates mouse movement from cursor position, so re-
    //    associate afterwards or the cursor sticks until the next real
    //    mouse move.
    if let Some(pos) = original {
        unsafe {
            CGWarpMouseCursorPosition(pos);
            CGAssociateMouseAndMouseCursorPosition(true);
        }
    }
}

// ---------------------------------------------------------------------------
// Mouse / cursor helpers.

fn post_mouse(source: &CGEventSource, kind: CGEventType, pos: CGPoint) {
    let Ok(ev) = CGEvent::new_mouse_event(source.clone(), kind, pos, CGMouseButton::Left) else {
        return;
    };
    ev.set_integer_value_field(EventField::EVENT_SOURCE_USER_DATA, INJECT_TAG as i64);
    // Session-level post: the event reaches apps/WindowServer but skips
    // HID-level taps from other tools (Karabiner-Elements, BetterTouchTool,
    // etc.) that might otherwise drop synthesized clicks. Posting our own
    // mouse events through an existing HID pipeline our keyboard tap owns
    // has been unreliable in testing.
    ev.post(CGEventTapLocation::Session);
}

/// Mouse event representing a pressed-button state (Down / Dragged / Up of
/// a click). Sets `clickState=1` and full pressure so WindowServer treats
/// it as a real click-drag rather than a cursor-moved-with-button-held
/// marker.
fn post_mouse_pressed(source: &CGEventSource, kind: CGEventType, pos: CGPoint) {
    let Ok(ev) = CGEvent::new_mouse_event(source.clone(), kind, pos, CGMouseButton::Left) else {
        return;
    };
    // `CGEventCreateMouseEvent` does NOT populate clickState. Without it
    // WindowServer treats the event as a mouse-moved-with-button-down
    // rather than a proper click/drag — Apple's docs are explicit about
    // this (see CGEventSetIntegerValueField reference).
    ev.set_integer_value_field(EventField::MOUSE_EVENT_CLICK_STATE, 1);
    // Pressure signals "fully pressed" — matters on Force Touch trackpads
    // where drag engagement is pressure-gated.
    ev.set_double_value_field(EventField::MOUSE_EVENT_PRESSURE, 1.0);
    ev.set_integer_value_field(EventField::EVENT_SOURCE_USER_DATA, INJECT_TAG as i64);
    ev.post(CGEventTapLocation::Session);
}

fn cursor_position() -> Option<CGPoint> {
    let source = CGEventSource::new(CGEventSourceStateID::HIDSystemState).ok()?;
    let ev = CGEvent::new(source).ok()?;
    Some(ev.location())
}

// ---------------------------------------------------------------------------
// Accessibility: query frontmost window's frame.

fn active_window_frame() -> Option<CGRect> {
    unsafe {
        let system = AXUIElementCreateSystemWide();
        if system.is_null() {
            return None;
        }
        let _system_guard = AXGuard(system);
        // Cap AX IPC at 250ms so a hung frontmost app can't stall us.
        AXUIElementSetMessagingTimeout(system, 0.25);

        let focused_app = ax_copy(system, "AXFocusedApplication")?;
        let _app_guard = AXGuard(focused_app);
        AXUIElementSetMessagingTimeout(focused_app, 0.25);

        let focused_window = ax_copy(focused_app, "AXFocusedWindow")?;
        let _window_guard = AXGuard(focused_window);

        let position = ax_copy(focused_window, "AXPosition")?;
        let _pos_guard = AXGuard(position);
        let size = ax_copy(focused_window, "AXSize")?;
        let _size_guard = AXGuard(size);

        let mut origin = CGPoint { x: 0.0, y: 0.0 };
        let mut dims = CGSize {
            width: 0.0,
            height: 0.0,
        };
        if !AXValueGetValue(
            position as AXValueRef,
            AX_VALUE_CG_POINT_TYPE,
            &mut origin as *mut CGPoint as *mut c_void,
        ) {
            return None;
        }
        if !AXValueGetValue(
            size as AXValueRef,
            AX_VALUE_CG_SIZE_TYPE,
            &mut dims as *mut CGSize as *mut c_void,
        ) {
            return None;
        }

        Some(CGRect {
            origin,
            size: dims,
        })
    }
}

/// Frame of one of the frontmost window's standard title-bar buttons, or
/// `None` if unavailable. Pass `"AXCloseButton"`, `"AXMinimizeButton"`,
/// or `"AXZoomButton"` — every macOS window with the standard chrome
/// exposes these via AX, and the returned CGRect is in screen coordinates
/// suitable for `CGEventPost` directly.
fn active_window_button_frame(button_attr: &str) -> Option<CGRect> {
    unsafe {
        let system = AXUIElementCreateSystemWide();
        if system.is_null() {
            return None;
        }
        let _system_guard = AXGuard(system);
        AXUIElementSetMessagingTimeout(system, 0.25);

        let focused_app = ax_copy(system, "AXFocusedApplication")?;
        let _app_guard = AXGuard(focused_app);
        AXUIElementSetMessagingTimeout(focused_app, 0.25);

        let focused_window = ax_copy(focused_app, "AXFocusedWindow")?;
        let _window_guard = AXGuard(focused_window);

        let button = ax_copy(focused_window, button_attr)?;
        let _button_guard = AXGuard(button);

        let position = ax_copy(button, "AXPosition")?;
        let _pos_guard = AXGuard(position);
        let size = ax_copy(button, "AXSize")?;
        let _size_guard = AXGuard(size);

        let mut origin = CGPoint { x: 0.0, y: 0.0 };
        let mut dims = CGSize {
            width: 0.0,
            height: 0.0,
        };
        if !AXValueGetValue(
            position as AXValueRef,
            AX_VALUE_CG_POINT_TYPE,
            &mut origin as *mut CGPoint as *mut c_void,
        ) {
            return None;
        }
        if !AXValueGetValue(
            size as AXValueRef,
            AX_VALUE_CG_SIZE_TYPE,
            &mut dims as *mut CGSize as *mut c_void,
        ) {
            return None;
        }

        Some(CGRect {
            origin,
            size: dims,
        })
    }
}

unsafe fn ax_copy(el: AXUIElementRef, attr: &str) -> Option<*mut c_void> {
    let key = CFString::new(attr);
    let mut out: CFTypeRef = ptr::null();
    let err = AXUIElementCopyAttributeValue(el, key.as_concrete_TypeRef(), &mut out);
    if err != AX_ERROR_SUCCESS || out.is_null() {
        return None;
    }
    // Reinterpret as `*mut` — AX returns CFTypeRef (*const) but downstream
    // AX calls take `*mut c_void` per the type alias we match. CF doesn't
    // distinguish const-ness at the ABI level.
    Some(out as *mut c_void)
}

struct AXGuard(AXUIElementRef);
impl Drop for AXGuard {
    fn drop(&mut self) {
        if !self.0.is_null() {
            unsafe { CFRelease(self.0 as CFTypeRef) }
        }
    }
}
