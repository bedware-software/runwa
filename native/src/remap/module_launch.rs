//! `open_module` rule action → JS.
//!
//! The hook thread can't open a palette itself — modules live in the
//! Electron main process — so it pushes the module id to a JS callback
//! registered via `set_open_module_callback`. Same no-polling shape as
//! `desktop.rs`: the threadsafe-function call only enqueues onto the Node
//! event loop and returns, so it is safe from inside the event-tap /
//! low-level-hook callback.

use napi::threadsafe_function::{ErrorStrategy, ThreadsafeFunction, ThreadsafeFunctionCallMode};
use once_cell::sync::Lazy;
use parking_lot::Mutex;

/// JS subscriber signature: `(moduleId: string) => void`.
pub type OpenModuleFn = ThreadsafeFunction<String, ErrorStrategy::Fatal>;

static CALLBACK: Lazy<Mutex<Option<OpenModuleFn>>> = Lazy::new(|| Mutex::new(None));

/// Register (or replace) the JS subscriber. Called once at startup.
pub fn set_callback(cb: OpenModuleFn) {
    *CALLBACK.lock() = Some(cb);
}

/// Ask JS to open `module`. Dropped with a log line when nothing has
/// subscribed yet — the hook can start before the JS side is wired.
pub fn fire(module: &str) {
    match CALLBACK.lock().as_ref() {
        Some(cb) => {
            cb.call(module.to_owned(), ThreadsafeFunctionCallMode::NonBlocking);
        }
        None => eprintln!("[keyboard-remap] open_module({module}) fired before JS subscribed"),
    }
}

/// JS subscriber for `shell:` rules: `(command: string) => void`. Shares
/// this file because it is the same hand-off — the hook only enqueues.
static SHELL_CALLBACK: Lazy<Mutex<Option<OpenModuleFn>>> = Lazy::new(|| Mutex::new(None));

pub fn set_shell_callback(cb: OpenModuleFn) {
    *SHELL_CALLBACK.lock() = Some(cb);
}

/// Ask JS to run `command` in the background. The command text is kept
/// out of the log: people put tokens in command lines.
pub fn fire_shell(command: String) {
    match SHELL_CALLBACK.lock().as_ref() {
        Some(cb) => {
            cb.call(command, ThreadsafeFunctionCallMode::NonBlocking);
        }
        None => eprintln!("[keyboard-remap] shell rule fired before JS subscribed"),
    }
}
