// No console window next to the app on Windows release builds.
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

//! Tauri shell for runwa.
//!
//! Same React UI as the Electron build (it talks to this process through the
//! `window.electronAPI` bridge in `src/renderer/src/lib/tauri-bridge.ts`),
//! same platform layer (`runwa-core`), no Node.js and no bundled Chromium.
//!
//! Threading: Tauri runs synchronous commands, window events, tray clicks
//! and global-shortcut callbacks on the main thread — the same thread the
//! Electron main process ran everything on. Platform calls keep that
//! guarantee here: anything that touches windows or focus either runs from
//! one of those entry points or is posted with `run_on_main_thread`.

mod app;
mod commands;
mod focus;
mod fuzzy;
mod glob;
mod hotkeys;
mod icons;
mod json_store;
mod modules;
mod palette;
mod paths;
mod settings;
mod settings_window;
mod stores;
mod tray;
mod types;
mod window_list;

fn main() {
    app::run();
}
