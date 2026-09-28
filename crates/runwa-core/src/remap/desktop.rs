//! Active-virtual-desktop signal shared between the keyboard-remap hook and
//! the shell (the tray icon).
//!
//! No polling. The number is *pushed* the instant a `switch_to_workspace` /
//! `move_to_workspace` rule action fires: the inject path calls [`record`],
//! which stores the latest 0-based ordinal (so a one-shot
//! `get_current_desktop_number` read at startup has something to return) and
//! invokes the subscriber registered via `set_desktop_change_callback`, so
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
use std::sync::Arc;

use once_cell::sync::Lazy;
use parking_lot::Mutex;

/// Subscriber signature: `(zero_based_desktop)`. Runs on the hook thread and
/// must return promptly — see `set_desktop_change_callback`.
pub type DesktopChangeFn = Arc<dyn Fn(u32) + Send + Sync>;

static CURRENT: AtomicU32 = AtomicU32::new(0);
static CALLBACK: Lazy<Mutex<Option<DesktopChangeFn>>> = Lazy::new(|| Mutex::new(None));

/// Register (or replace) the subscriber notified on every desktop change.
/// Called once from `set_desktop_change_callback` at startup.
pub fn set_callback(cb: DesktopChangeFn) {
    *CALLBACK.lock() = Some(cb);
}

/// Record the active desktop (0-based) and push it to the subscriber.
/// Invoked from the keyboard-remap hook thread when a workspace switch/move
/// rule action fires. The lock is released before the subscriber runs, so a
/// subscriber that re-registers can't deadlock against us.
pub fn record(zero_based: u32) {
    CURRENT.store(zero_based, Ordering::Relaxed);
    let callback = CALLBACK.lock().clone();
    if let Some(cb) = callback {
        cb(zero_based);
    }
}

/// Last recorded 0-based ordinal. Consulted only on macOS, which has no
/// public Space-ordinal API to read instead.
#[cfg(target_os = "macos")]
pub fn get() -> u32 {
    CURRENT.load(Ordering::Relaxed)
}
