//! Active-virtual-desktop signal shared between the keyboard-remap hook and
//! the JS layer (the tray icon).
//!
//! No polling. The number is *pushed* the instant a `switch_to_workspace` /
//! `move_to_workspace` rule action fires: the inject path calls [`record`],
//! which stores the latest 0-based ordinal (so a one-shot
//! `get_current_desktop_number` read at startup has something to return) and
//! invokes the JS callback registered via `set_desktop_change_callback`, so
//! the tray repaints immediately.
//!
//! Platform notes:
//!   - macOS has no public Space-ordinal API, so the stored value is the
//!     last number the *user* asked runwa to switch to. Switches made via
//!     the system's own Ctrl+N shortcut or a trackpad gesture aren't
//!     observed. Starts at 0 (desktop 1) until the first runwa switch.
//!   - Windows reads the real ordinal from `winvd` for the startup read, but
//!     live updates still flow through `record` so the tray never polls.

use std::sync::atomic::{AtomicU32, Ordering};

use napi::threadsafe_function::{ErrorStrategy, ThreadsafeFunction, ThreadsafeFunctionCallMode};
use once_cell::sync::Lazy;
use parking_lot::Mutex;

/// JS subscriber signature: `(zeroBasedDesktop: number) => void`. `Fatal`
/// error strategy — there is no error channel, we only ever push a number.
pub type DesktopChangeFn = ThreadsafeFunction<u32, ErrorStrategy::Fatal>;

static CURRENT: AtomicU32 = AtomicU32::new(0);
static CALLBACK: Lazy<Mutex<Option<DesktopChangeFn>>> = Lazy::new(|| Mutex::new(None));

/// Register (or replace) the JS subscriber notified on every desktop change.
/// Called once from `set_desktop_change_callback` at startup.
pub fn set_callback(cb: DesktopChangeFn) {
    *CALLBACK.lock() = Some(cb);
}

/// Record the active desktop (0-based) and push it to the JS subscriber.
/// Invoked from the keyboard-remap hook thread when a workspace switch/move
/// rule action fires. The threadsafe-function call is non-blocking — it
/// enqueues onto the Node event loop and returns at once, so holding the
/// callback lock across it is safe (no JS runs synchronously here).
pub fn record(zero_based: u32) {
    CURRENT.store(zero_based, Ordering::Relaxed);
    if let Some(cb) = CALLBACK.lock().as_ref() {
        cb.call(zero_based, ThreadsafeFunctionCallMode::NonBlocking);
    }
}

/// Last recorded 0-based ordinal. Consulted only on macOS, which has no
/// public Space-ordinal API to read instead.
#[cfg(target_os = "macos")]
pub fn get() -> u32 {
    CURRENT.load(Ordering::Relaxed)
}
