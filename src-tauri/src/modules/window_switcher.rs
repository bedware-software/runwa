//! Window Switcher — port of `src/main/modules/window-switcher/index.ts`.
//!
//! Lists every open window (current desktop by default), fuzzy-filters it
//! by title and process name, and focuses the chosen one. The list is
//! z-ordered, which is what makes the hotkey's double-press ("activate the
//! second row") an Alt+Tab-style bounce between the two latest windows.

use std::collections::HashSet;

use serde_json::Value;
use tauri::{AppHandle, Manager};

use super::{ExecuteOutcome, PaletteModule, SearchContext};
use crate::app::AppState;
use crate::fuzzy::{fuzzy_score, typo_score};
use crate::stores::is_window_ignored;
use crate::types::{ConfigField, ModuleKind, ModuleManifest, PaletteItem, SecondPress};
use crate::window_list;

pub const MODULE_ID: &str = "window-switcher";
pub const FOCUS_ACTION: &str = "focus-window";

/// The fullscreen remap bypass is implemented in the Windows hook only.
const SUPPORTS_FULLSCREEN_BYPASS: bool = cfg!(target_os = "windows");

pub struct WindowSwitcher {
    manifest: ModuleManifest,
}

impl WindowSwitcher {
    pub fn new() -> Self {
        Self {
            manifest: ModuleManifest {
                id: MODULE_ID.into(),
                name: "Window Switcher".into(),
                icon: "app-window".into(),
                kind: ModuleKind::Search,
                description: "Jump to any open window on your desktop — like PowerToys Window Walker.".into(),
                default_enabled: true,
                supports_direct_launch: true,
                default_direct_launch_hotkey: Some("Ctrl+Alt+Super+W".into()),
                direct_launch_second_press: Some(SecondPress::ActivateSecond),
                // `currentDesktopOnly` also lives in this module's config bag
                // but isn't a field: the palette flips it inline (the "This
                // desktop / All desktops" chip + Tab). Missing means `true`.
                config_fields: vec![
                    ConfigField::checkbox(
                        "hideSystemWindows",
                        "Hide system windows",
                        "Hide suspended Windows shell surfaces (Start, Search, Notification Center, Lock Screen, TextInputHost, etc.) that report as windows but aren't actually visible. Turn off to see every HWND on the desktop.",
                        true,
                    ),
                    ConfigField::checkbox(
                        "autoSelectSingleMatch",
                        "Auto-select single match",
                        "When your search narrows to exactly one window, focus it immediately instead of waiting for Enter. Only fires while you're typing a query — opening the switcher with a single window on the desktop never auto-focuses.",
                        false,
                    ),
                ],
                default_aliases: None,
            },
        }
    }
}

/// A window as the palette renders it: blank titles fall back to the
/// process name (macOS without Screen Recording permission reports none).
struct Row {
    window: runwa_core::NativeWindow,
    title: String,
}

fn native_id(item: &PaletteItem) -> Option<&str> {
    if item.action_kind != FOCUS_ACTION {
        return None;
    }
    item.action.get("nativeId").and_then(Value::as_str)
}

impl PaletteModule for WindowSwitcher {
    fn manifest(&self) -> &ModuleManifest {
        &self.manifest
    }

    fn search(
        &self,
        app: &AppHandle,
        query: &str,
        context: &SearchContext<'_>,
    ) -> Vec<PaletteItem> {
        let state = app.state::<AppState>();
        // Missing values mean `true` — fresh installs never wrote them.
        let current_desktop_only =
            context.config.get("currentDesktopOnly") != Some(&Value::Bool(false));
        let hide_system_windows =
            context.config.get("hideSystemWindows") != Some(&Value::Bool(false));

        // Palette just opened: re-enumerate so the list reflects the desktop now.
        if query.is_empty() {
            window_list::invalidate();
        }

        let windows =
            match window_list::list_windows_cached(current_desktop_only, hide_system_windows) {
                Ok(windows) => windows,
                Err(err) => {
                    log::warn!("[window-switcher] listing failed: {err}");
                    return Vec::new();
                }
            };

        let ignore_rules = state.window_ignore.list();
        let own_pid = std::process::id();
        // Real per-window titles always get their own row, even when two
        // windows share a title. Rows whose title fell back to the process
        // name are indistinguishable, so they collapse to one per app.
        let mut seen = HashSet::new();
        let rows: Vec<Row> = windows
            .into_iter()
            .filter(|w| w.pid != own_pid)
            .filter_map(|window| {
                let trimmed = window.title.trim();
                let fell_back = trimmed.is_empty();
                let title = if fell_back {
                    window.process_name.clone()
                } else {
                    trimmed.to_owned()
                };
                if title.is_empty()
                    || is_window_ignored(&ignore_rules, &title, &window.process_name)
                {
                    return None;
                }
                if fell_back && !seen.insert(format!("{}\u{0}{}", window.pid, title)) {
                    return None;
                }
                Some(Row { window, title })
            })
            .collect();

        let to_item = |row: &Row, score: f64| -> PaletteItem {
            let w = &row.window;
            // Icon precedence: the HWND's own icon (what the taskbar shows),
            // then the executable's, then a Lucide glyph.
            let icon = state
                .icons
                .window_icon(&w.id)
                .or_else(|| state.icons.file_icon(w.executable_path.as_deref()))
                .unwrap_or_else(|| "app-window".into());
            let bypassed =
                SUPPORTS_FULLSCREEN_BYPASS && state.fullscreen_bypass.has(&w.process_name);
            PaletteItem {
                id: format!("win:{}", w.id),
                title: row.title.clone(),
                subtitle: Some(w.process_name.clone()),
                icon_hint: Some(icon),
                // Drives the Ctrl+K "Show in file explorer" action.
                reveal_path: w.executable_path.clone(),
                icon_badge: bypassed.then(|| "keyboard-off".into()),
                icon_tooltip: bypassed
                    .then(|| "Key remapping is disabled while this app is fullscreen".into()),
                action_kind: FOCUS_ACTION.into(),
                action: serde_json::json!({ "nativeId": w.id }),
                score: Some(score),
                ..PaletteItem::default()
            }
        };

        let query = query.trim();
        if query.is_empty() {
            return rows
                .iter()
                .enumerate()
                .map(|(i, row)| to_item(row, i as f64 / 10_000.0))
                .collect();
        }

        // Scored on title and process name, best of the two: the title is
        // what the user reads, the process name what they remember for a
        // window titled after a document.
        let mut matches: Vec<(&Row, f64)> = rows
            .iter()
            .filter_map(|row| {
                let by_title = fuzzy_score(query, &row.title);
                let by_process = fuzzy_score(query, &row.window.process_name);
                let best = match (by_title, by_process) {
                    (Some(a), Some(b)) => Some(a.min(b)),
                    (a, b) => a.or(b),
                };
                best.map(|score| (row, score))
            })
            .collect();

        // Nothing matched character-for-character: the typo-tolerant pass
        // runs only now, so its looseness can't outrank a real match.
        if matches.is_empty() {
            matches = rows
                .iter()
                .filter_map(|row| {
                    let by_title = typo_score(query, &row.title);
                    let by_process = typo_score(query, &row.window.process_name);
                    let best = match (by_title, by_process) {
                        (Some(a), Some(b)) => Some(a.min(b)),
                        (a, b) => a.or(b),
                    };
                    best.map(|score| (row, score))
                })
                .collect();
        }

        matches.sort_by(|a, b| a.1.partial_cmp(&b.1).unwrap_or(std::cmp::Ordering::Equal));
        let mut items: Vec<PaletteItem> = matches
            .iter()
            .map(|(row, score)| to_item(row, *score))
            .collect();

        // Opt-in: once a typed query narrows to one window, focus it without
        // an Enter press. Never on the empty query.
        if context.config.get("autoSelectSingleMatch") == Some(&Value::Bool(true))
            && items.len() == 1
        {
            items[0].auto_execute = Some(true);
        }
        items
    }

    fn execute(&self, _app: &AppHandle, item: &PaletteItem) -> Result<ExecuteOutcome, String> {
        let Some(id) = native_id(item) else {
            log::warn!("[window-switcher] invalid action {:?}", item.action);
            return Ok(ExecuteOutcome {
                dismiss_palette: false,
            });
        };
        match runwa_core::focus_window(id) {
            // The window probably closed between listing and focus.
            Ok(false) => window_list::invalidate(),
            Ok(true) => {}
            Err(err) => log::warn!("[window-switcher] focus failed: {err}"),
        }
        Ok(ExecuteOutcome {
            dismiss_palette: true,
        })
    }
}

/// The native window id behind a palette row, when it is a Window Switcher
/// row — the only shape the close / ignore / bypass commands accept.
pub fn window_row_id(item: &PaletteItem) -> Option<&str> {
    if item.module_id != MODULE_ID {
        return None;
    }
    native_id(item)
}
