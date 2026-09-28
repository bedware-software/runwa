//! "Which app was the user in when they opened the palette?" — port of
//! `src/main/focus-context.ts`.
//!
//! The palette steals focus the moment it appears, so the answer is captured
//! at show time (a bare id assignment on the hot path) and resolved lazily,
//! once per palette session, only by the modules that care.

use parking_lot::Mutex;
use runwa_core::NativeWindow;
use serde::Serialize;

use crate::window_list;

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FocusedApp {
    /// Native window id — HWND string on Windows, `${pid}:${cgWindowId}` on macOS.
    pub window_id: String,
    pub pid: Option<u32>,
    /// 'idea64.exe' on Windows, 'IntelliJ IDEA' on macOS.
    pub process_name: String,
    pub executable_path: Option<String>,
    pub bundle_id: Option<String>,
    pub title: String,
}

impl From<NativeWindow> for FocusedApp {
    fn from(window: NativeWindow) -> Self {
        Self {
            window_id: window.id,
            pid: Some(window.pid),
            process_name: window.process_name,
            executable_path: window.executable_path,
            bundle_id: window.bundle_id,
            title: window.title,
        }
    }
}

/// Windows resolves an id directly; macOS ids are `${pid}:${cgWindowId}` and
/// `describe_window` isn't implemented there, so fall back to the cached
/// current-desktop listing — the exact window, else any window of the pid.
fn resolve_window(window_id: &str) -> Option<FocusedApp> {
    match runwa_core::describe_window(window_id) {
        Ok(Some(window)) => return Some(window.into()),
        Ok(None) => {}
        Err(err) => log::warn!("[focus-context] describe_window failed: {err}"),
    }
    let pid = window_id
        .split(':')
        .next()
        .and_then(|p| p.parse::<u32>().ok());
    match window_list::list_windows_cached(true, true) {
        Ok(windows) => {
            let exact = windows.iter().find(|w| w.id == window_id);
            let same_app = || pid.and_then(|pid| windows.iter().find(|w| w.pid == pid));
            exact.or_else(same_app).cloned().map(FocusedApp::from)
        }
        Err(err) => {
            log::warn!("[focus-context] window listing failed: {err}");
            None
        }
    }
}

#[derive(Default)]
struct State {
    window_id: Option<String>,
    /// `None` = not resolved yet, `Some(None)` = resolved to "unknown app".
    resolved: Option<Option<FocusedApp>>,
}

#[derive(Default)]
pub struct FocusContext {
    state: Mutex<State>,
}

impl FocusContext {
    /// Record the window that had focus before the palette took it.
    pub fn capture(&self, window_id: Option<String>) {
        *self.state.lock() = State {
            window_id,
            resolved: None,
        };
    }

    pub fn clear(&self) {
        *self.state.lock() = State::default();
    }

    /// The app behind the palette, or `None` when it can't be identified.
    pub fn get(&self) -> Option<FocusedApp> {
        let mut state = self.state.lock();
        if let Some(resolved) = &state.resolved {
            return resolved.clone();
        }
        let resolved = state.window_id.as_deref().and_then(resolve_window);
        state.resolved = Some(resolved.clone());
        resolved
    }
}
