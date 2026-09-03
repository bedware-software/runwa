//! macOS: close the frontmost window — the window, not the app.
//!
//! There is no macOS equivalent of Alt+F4, and no keystroke that means
//! "close this window" everywhere: Cmd+Q quits the whole app, Cmd+W is
//! "close tab" in every browser and editor, Cmd+Shift+W exists in some
//! apps and not others. The one gesture that is universal is the red
//! traffic light, and Accessibility lets us press it directly — no cursor
//! warp, no per-app shortcut table, no AppleScript. The app receives
//! exactly what a real click delivers, so "save changes?" prompts still
//! appear and nothing is force-killed.
//!
//! The chain, in order:
//!   1. `AXPress` the focused window's `AXCloseButton`.
//!   2. A fullscreen window publishes no close button (the traffic lights
//!      live in the auto-hiding title bar), so leave fullscreen first and
//!      press the button once it reappears.
//!   3. Nothing AX-shaped to aim at — synthesize Cmd+W and hope the app
//!      binds it.
//!
//! Requires Accessibility permission, already granted for the keyboard
//! hook itself.

use std::thread;
use std::time::{Duration, Instant};

use core_graphics::event::CGEventFlags;

use super::macos_ax::{self, AXGuard};
use super::rules::{Modifier, NamedKey, SyntheticEvent};

/// How long to keep trying for the close button after asking a window to
/// leave fullscreen. The exit animation is ~500ms on Sequoia; the extra
/// headroom costs nothing on a detached thread.
const FULLSCREEN_EXIT_TIMEOUT: Duration = Duration::from_millis(1500);
/// Gap between attempts while that animation runs. macOS publishes no
/// "finished leaving fullscreen" signal an out-of-process observer can
/// wait on without parking an AXObserver run loop on this thread, so a
/// bounded retry is how we notice the moment the button comes back.
const FULLSCREEN_RETRY_INTERVAL: Duration = Duration::from_millis(75);

pub fn close_focused_window() {
    // Detach — the hook callback must return promptly or CGEventTap will
    // disable us via TapDisabledByTimeout. AX calls are cross-process IPC,
    // and the fullscreen path deliberately sleeps.
    thread::Builder::new()
        .name("runwa-close-window".into())
        .spawn(run_close_sequence)
        .map_err(|e| eprintln!("[keyboard-remap] close_window spawn failed: {e}"))
        .ok();
}

fn run_close_sequence() {
    let Some(window) = focused_window() else {
        eprintln!("[keyboard-remap] close_window: no focused window found via AX");
        send_close_shortcut();
        return;
    };

    if press_close_button(&window) {
        return;
    }

    // No close button. If the window is fullscreen that's expected — the
    // traffic lights aren't in the AX tree while the title bar is hidden.
    // Dropping out of fullscreen brings them back, and the window still
    // ends up closed, which is what the user asked for.
    if macos_ax::attribute_is_true(&window, "AXFullScreen")
        && macos_ax::set_bool_attribute(&window, "AXFullScreen", false)
        && press_close_button_within(&window, FULLSCREEN_EXIT_TIMEOUT)
    {
        return;
    }

    eprintln!("[keyboard-remap] close_window: focused window exposes no AXCloseButton; falling back to Cmd+W");
    send_close_shortcut();
}

/// The window the user is looking at. `AXFocusedWindow` is the answer for
/// virtually every app; `AXMainWindow` covers the few that leave the
/// focused-window attribute unset while a window is plainly key.
fn focused_window() -> Option<AXGuard> {
    macos_ax::focused_window().or_else(|| {
        let app = macos_ax::focused_application()?;
        macos_ax::attribute(&app, "AXMainWindow")
    })
}

fn press_close_button(window: &AXGuard) -> bool {
    let Some(button) = macos_ax::attribute(window, "AXCloseButton") else {
        return false;
    };
    macos_ax::perform(&button, "AXPress")
}

fn press_close_button_within(window: &AXGuard, timeout: Duration) -> bool {
    let deadline = Instant::now() + timeout;
    loop {
        if press_close_button(window) {
            return true;
        }
        if Instant::now() >= deadline {
            return false;
        }
        thread::sleep(FULLSCREEN_RETRY_INTERVAL);
    }
}

/// Last resort. Cmd+W is the wrong gesture in a browser — that closes a
/// tab, which is exactly why it isn't the primary path — but a window
/// with no close button and no fullscreen state to leave has nothing
/// else left to aim at.
fn send_close_shortcut() {
    super::macos::inject(
        &[
            SyntheticEvent::ModifierDown(Modifier::Cmd),
            SyntheticEvent::KeyDown(NamedKey::Alpha(b'W')),
            SyntheticEvent::KeyUp(NamedKey::Alpha(b'W')),
            SyntheticEvent::ModifierUp(Modifier::Cmd),
        ],
        CGEventFlags::empty(),
    );
}
