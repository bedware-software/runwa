//! Short-lived cache over `runwa_core::list_windows` — port of the cache in
//! `src/main/modules/window-switcher/native.ts`.
//!
//! A 100 ms TTL per listing mode avoids re-enumerating on every keystroke
//! while still returning fresh data when the palette is re-opened (the
//! switcher also invalidates explicitly on an empty query).

use std::collections::HashMap;
use std::time::{Duration, Instant};

use parking_lot::{const_mutex, Mutex};
use runwa_core::NativeWindow;

const CACHE_TTL: Duration = Duration::from_millis(100);

/// `(current_desktop_only, hide_system_windows)` → when listed, and what.
type Cache = HashMap<(bool, bool), (Instant, Vec<NativeWindow>)>;

static CACHE: Mutex<Option<Cache>> = const_mutex(None);

pub fn list_windows_cached(
    current_desktop_only: bool,
    hide_system_windows: bool,
) -> runwa_core::Result<Vec<NativeWindow>> {
    let key = (current_desktop_only, hide_system_windows);
    if let Some((at, windows)) = CACHE.lock().as_ref().and_then(|cache| cache.get(&key)) {
        if at.elapsed() < CACHE_TTL {
            return Ok(windows.clone());
        }
    }
    let windows = runwa_core::list_windows(current_desktop_only, hide_system_windows)?;
    CACHE
        .lock()
        .get_or_insert_with(HashMap::new)
        .insert(key, (Instant::now(), windows.clone()));
    Ok(windows)
}

pub fn invalidate() {
    if let Some(cache) = CACHE.lock().as_mut() {
        cache.clear();
    }
}
