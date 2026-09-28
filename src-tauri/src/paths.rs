//! Where runwa keeps its data.
//!
//! The Electron build stores everything under `app.getPath('userData')`:
//! `<config dir>/Runwa` for installs and `<config dir>/Runwa Dev` for
//! `npm run dev`, where `<config dir>` is `%APPDATA%` on Windows,
//! `~/Library/Application Support` on macOS and `~/.config` on Linux.
//!
//! A release build of this shell uses the very same `Runwa` folder, so
//! replacing the Electron install with the Tauri one keeps every setting,
//! hotkey and list. Debug builds get their own `Runwa Tauri Dev` folder —
//! a dev instance must never rewrite the data of the app the user actually
//! runs — seeded once with a copy of the Electron data so there is
//! something realistic to look at.

use std::fs;
use std::path::{Path, PathBuf};

use tauri::{AppHandle, Manager};

/// Top-level files worth copying into a fresh dev folder. The Electron
/// user-data folder also holds Chromium's own state (caches, LevelDB,
/// cookies), none of which means anything to this shell.
const SEED_EXTENSIONS: &[&str] = &["json", "yaml", "yml", "md"];

#[derive(Clone, Debug)]
pub struct Paths {
    /// User-facing app name — "Runwa", or a dev label for debug builds.
    pub app_name: String,
    pub user_data: PathBuf,
}

impl Paths {
    pub fn resolve(app: &AppHandle) -> Self {
        let config_dir = app
            .path()
            .config_dir()
            .unwrap_or_else(|_| std::env::temp_dir());

        if cfg!(debug_assertions) {
            let user_data = config_dir.join("Runwa Tauri Dev");
            if !user_data.join("runwa-settings.json").exists() {
                seed_dev_folder(
                    &user_data,
                    &[config_dir.join("Runwa Dev"), config_dir.join("Runwa")],
                );
            }
            ensure_dir(&user_data);
            Self {
                app_name: "Runwa Tauri Dev".into(),
                user_data,
            }
        } else {
            let user_data = config_dir.join("Runwa");
            ensure_dir(&user_data);
            Self {
                app_name: "Runwa".into(),
                user_data,
            }
        }
    }

    pub fn file(&self, name: &str) -> PathBuf {
        self.user_data.join(name)
    }
}

fn ensure_dir(dir: &Path) {
    if let Err(err) = fs::create_dir_all(dir) {
        log::error!("[paths] cannot create {}: {err}", dir.display());
    }
}

/// Copy the store files of the first existing Electron folder into `target`.
fn seed_dev_folder(target: &Path, sources: &[PathBuf]) {
    let Some(source) = sources
        .iter()
        .find(|dir| dir.join("runwa-settings.json").is_file())
    else {
        return;
    };
    ensure_dir(target);
    let entries = match fs::read_dir(source) {
        Ok(entries) => entries,
        Err(err) => {
            log::warn!("[paths] cannot read {}: {err}", source.display());
            return;
        }
    };
    let mut copied = 0;
    for entry in entries.flatten() {
        let path = entry.path();
        let wanted = path.is_file()
            && path
                .extension()
                .and_then(|ext| ext.to_str())
                .is_some_and(|ext| SEED_EXTENSIONS.contains(&ext.to_ascii_lowercase().as_str()));
        if !wanted {
            continue;
        }
        let Some(name) = path.file_name() else {
            continue;
        };
        match fs::copy(&path, target.join(name)) {
            Ok(_) => copied += 1,
            Err(err) => log::warn!("[paths] copying {} failed: {err}", path.display()),
        }
    }
    log::info!(
        "[paths] seeded {} with {copied} file(s) from {}",
        target.display(),
        source.display()
    );
}
