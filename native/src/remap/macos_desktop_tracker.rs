//! Current-virtual-desktop tracker for macOS.
//!
//! macOS Spaces don't expose a stable public ordinal API — CGS private
//! functions return UUIDs, not positions. The pragmatic substitute is to
//! shadow-track the number the *user* asked runwa to switch to, via the
//! `switch_to_workspace` / `move_to_workspace` rule actions that pass an
//! integer N. Each fire updates this atomic; `get_current_desktop_number`
//! on the Rust side reads it back for the tray and anything else that
//! needs a "which Space am I on" signal.
//!
//! Caveats:
//!   - Switches the user makes via the system's own Ctrl+N shortcut or a
//!     trackpad gesture aren't observed; the tracker stays at the last
//!     runwa-initiated value until another runwa switch fires.
//!   - Defaults to 0 at startup because we don't know which Space is
//!     active — the user's first `switch_to_workspace` corrects it.

use std::sync::atomic::{AtomicU32, Ordering};

static CURRENT: AtomicU32 = AtomicU32::new(0);

/// Store a 0-based desktop ordinal. Rules in YAML are 1-based, so the
/// macOS inject path converts (`set(n - 1)`) before calling this.
pub fn set(zero_based: u32) {
    CURRENT.store(zero_based, Ordering::Relaxed);
}

pub fn get() -> u32 {
    CURRENT.load(Ordering::Relaxed)
}
