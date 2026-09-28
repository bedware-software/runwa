//! macOS: close the frontmost window — the window, not the app.
//!
//! This is the window switcher's Cmd+D, aimed at whatever is in front
//! instead of at the row the user highlighted. Both halves are the
//! switcher's own, already load-bearing code:
//!
//!   * [`crate::macos::get_foreground_window`] — the topmost on-screen
//!     `kCGWindowLayer == 0` window that isn't ours, as `"pid:wid"`.
//!     WindowServer answers this, so it needs no cooperation from the
//!     app.
//!   * [`crate::macos::close_window`] — finds that window in the owning
//!     app's AX tree by CGWindowID and presses its close button. The app
//!     sees exactly what a click on the red traffic light delivers, so
//!     "save changes?" prompts still appear and nothing is force-killed.
//!
//! Deliberately no keystroke fallback. Cmd+W is "close tab" in every
//! browser and editor, so a fallback doesn't degrade — it silently does
//! the wrong thing, which is the whole reason this action exists.

use std::thread;

pub fn close_focused_window() {
    // Detach — the hook callback must return promptly or CGEventTap will
    // disable us via TapDisabledByTimeout, and the AX round-trip below is
    // IPC into another process.
    thread::Builder::new()
        .name("runwa-close-window".into())
        .spawn(run_close)
        .map_err(|e| eprintln!("[keyboard-remap] close_window spawn failed: {e}"))
        .ok();
}

fn run_close() {
    let id = match crate::macos::get_foreground_window() {
        Ok(id) if !id.is_empty() => id,
        Ok(_) => {
            eprintln!("[keyboard-remap] close_window: no foreground window");
            return;
        }
        Err(e) => {
            eprintln!("[keyboard-remap] close_window: foreground lookup failed: {e}");
            return;
        }
    };

    match crate::macos::close_window(&id) {
        Ok(true) => {}
        Ok(false) => eprintln!("[keyboard-remap] close_window: {id} refused the close press"),
        Err(e) => eprintln!("[keyboard-remap] close_window: {id} failed: {e}"),
    }
}
