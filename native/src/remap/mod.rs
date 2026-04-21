//! Cross-platform keyboard remapping.
//!
//! Public surface:
//!   - `start(rules_json)` — installs a low-level keyboard hook on the current
//!     platform and returns a handle id. Windows uses `SetWindowsHookEx`;
//!     macOS uses `CGEventTapCreate`.
//!   - `stop(handle)` — tears down the hook.
//!
//! All state-machine logic and synthesis lives in platform-agnostic modules
//! (`state`, `rules`, `synth`). Platform modules only handle the OS glue
//! (install hook, pump events, inject synthetic keys).

pub mod rules;
pub mod state;
pub mod synth;

#[cfg(target_os = "windows")]
pub mod windows;

#[cfg(target_os = "macos")]
pub mod macos;

#[cfg(target_os = "macos")]
pub mod macos_move_window;

#[cfg(target_os = "macos")]
pub mod macos_desktop_tracker;

use once_cell::sync::Lazy;
use parking_lot::Mutex;
use std::collections::HashMap;

/// Handle returned to JS. Opaque integer.
pub type HandleId = u32;

/// A running hook owns whatever platform-specific teardown primitive is
/// needed. `stop` consumes the handle.
pub trait HookHandle: Send {
    fn stop(self: Box<Self>);
}

static REGISTRY: Lazy<Mutex<HashMap<HandleId, Box<dyn HookHandle>>>> =
    Lazy::new(|| Mutex::new(HashMap::new()));
static NEXT_ID: Lazy<Mutex<HandleId>> = Lazy::new(|| Mutex::new(1));

fn allocate_id() -> HandleId {
    let mut guard = NEXT_ID.lock();
    let id = *guard;
    *guard = guard.wrapping_add(1);
    id
}

fn store(handle: Box<dyn HookHandle>) -> HandleId {
    let id = allocate_id();
    REGISTRY.lock().insert(id, handle);
    id
}

/// Install a keyboard hook. Returns a handle id on success. The rules JSON
/// is parsed here; errors propagate to the JS caller.
pub fn start(rules_json: &str) -> Result<HandleId, String> {
    let rules = rules::parse(rules_json).map_err(|e| format!("rules parse error: {e}"))?;

    #[cfg(target_os = "windows")]
    {
        let handle = windows::install(rules).map_err(|e| format!("install error: {e}"))?;
        return Ok(store(Box::new(handle)));
    }

    #[cfg(target_os = "macos")]
    {
        let handle = macos::install(rules).map_err(|e| format!("install error: {e}"))?;
        return Ok(store(Box::new(handle)));
    }

    #[cfg(not(any(target_os = "windows", target_os = "macos")))]
    {
        // Linux / other: no-op. Return a dummy handle so the JS side doesn't
        // have to special-case the platform.
        let _ = rules;
        Ok(store(Box::new(NoopHandle)))
    }
}

pub fn stop(handle: HandleId) -> Result<(), String> {
    let entry = REGISTRY.lock().remove(&handle);
    match entry {
        Some(h) => {
            h.stop();
            Ok(())
        }
        None => Err(format!("unknown handle: {handle}")),
    }
}

#[cfg(not(any(target_os = "windows", target_os = "macos")))]
struct NoopHandle;

#[cfg(not(any(target_os = "windows", target_os = "macos")))]
impl HookHandle for NoopHandle {
    fn stop(self: Box<Self>) {}
}
