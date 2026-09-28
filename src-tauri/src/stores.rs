//! The Window Switcher's two side lists, each in its own electron-store
//! compatible file (ports of `window-switcher/ignore-store.ts` and
//! `keyboard-remap/fullscreen-bypass-store.ts`).
//!
//! They live outside the settings object for the same reasons as in the
//! Electron build: the generic module-config schema is scalar-only, and the
//! ignore list is read on every switcher keystroke, so it must not ride along
//! with every settings broadcast.

use std::collections::HashSet;
use std::path::PathBuf;

use parking_lot::Mutex;
use serde_json::{json, Value};

use crate::glob::glob_matches;
use crate::json_store;
use crate::types::{NewWindowIgnoreRule, WindowIgnoreRule};

pub const IGNORE_FILE: &str = "runwa-window-switcher-ignore.json";
pub const BYPASS_FILE: &str = "runwa-remap-fullscreen-bypass.json";

pub const MAX_IGNORE_RULES: usize = 500;
pub const MAX_IGNORE_FIELD_LENGTH: usize = 512;
const MAX_IGNORE_RULE_ID_LENGTH: usize = 200;

pub const MAX_BYPASS_PROCESSES: usize = 200;
pub const MAX_PROCESS_NAME_LENGTH: usize = 260;

/// JS `String.prototype.length` counts UTF-16 units; the limits were
/// written against that, so measure the same way.
fn js_len(s: &str) -> usize {
    s.encode_utf16().count()
}

/// True when the window should be hidden from the switcher. `title` and
/// `process_name` must be the values the palette renders, since those are
/// what the user saw when they created the rule.
pub fn is_window_ignored(rules: &[WindowIgnoreRule], title: &str, process_name: &str) -> bool {
    rules.iter().any(|rule| {
        !(rule.title.is_empty() && rule.process_name.is_empty())
            && glob_matches(&rule.title, title)
            && glob_matches(&rule.process_name, process_name)
    })
}

fn rule_key(title: &str, process_name: &str) -> String {
    format!(
        "{}\u{0}{}",
        title.to_lowercase(),
        process_name.to_lowercase()
    )
}

fn string_field(value: &Option<Value>) -> String {
    value
        .as_ref()
        .and_then(Value::as_str)
        .map(|s| s.trim().to_owned())
        .unwrap_or_default()
}

fn parse_new_rule(rule: &NewWindowIgnoreRule) -> Result<(String, String), String> {
    let title = string_field(&rule.title);
    let process_name = string_field(&rule.process_name);
    if title.is_empty() && process_name.is_empty() {
        return Err("A window title or an executable name is required.".into());
    }
    if js_len(&title) > MAX_IGNORE_FIELD_LENGTH || js_len(&process_name) > MAX_IGNORE_FIELD_LENGTH {
        return Err(format!(
            "Titles and executable names can be at most {MAX_IGNORE_FIELD_LENGTH} characters."
        ));
    }
    Ok((title, process_name))
}

/// Drop malformed hand-edited entries before they reach the matcher. A rule
/// with both fields empty would hide every window, so it's discarded.
fn sanitise_rules(value: Option<&Value>) -> Vec<WindowIgnoreRule> {
    let Some(entries) = value.and_then(Value::as_array) else {
        return Vec::new();
    };
    let mut rules = Vec::new();
    let mut seen_ids = HashSet::new();
    let mut seen_keys = HashSet::new();
    for entry in entries {
        if rules.len() >= MAX_IGNORE_RULES {
            break;
        }
        let Some(id) = entry.get("id").and_then(Value::as_str).map(str::trim) else {
            continue;
        };
        let text = |key: &str| {
            entry
                .get(key)
                .and_then(Value::as_str)
                .map(|s| s.trim().to_owned())
                .unwrap_or_default()
        };
        let title = text("title");
        let process_name = text("processName");
        let key = rule_key(&title, &process_name);
        if id.is_empty()
            || js_len(id) > MAX_IGNORE_RULE_ID_LENGTH
            || (title.is_empty() && process_name.is_empty())
            || js_len(&title) > MAX_IGNORE_FIELD_LENGTH
            || js_len(&process_name) > MAX_IGNORE_FIELD_LENGTH
            || seen_ids.contains(id)
            || seen_keys.contains(&key)
        {
            continue;
        }
        seen_ids.insert(id.to_owned());
        seen_keys.insert(key);
        rules.push(WindowIgnoreRule {
            id: id.to_owned(),
            title,
            process_name,
        });
    }
    rules
}

pub struct WindowIgnoreStore {
    path: PathBuf,
    rules: Mutex<Vec<WindowIgnoreRule>>,
}

impl WindowIgnoreStore {
    pub fn load(path: PathBuf) -> Self {
        let rules = sanitise_rules(
            json_store::read_object(&path)
                .as_ref()
                .and_then(|m| m.get("rules")),
        );
        Self {
            path,
            rules: Mutex::new(rules),
        }
    }

    pub fn list(&self) -> Vec<WindowIgnoreRule> {
        self.rules.lock().clone()
    }

    pub fn add(&self, rule: &NewWindowIgnoreRule) -> Result<Vec<WindowIgnoreRule>, String> {
        let (title, process_name) = parse_new_rule(rule)?;
        let mut rules = self.rules.lock();
        if rules.len() >= MAX_IGNORE_RULES {
            return Err(format!(
                "You can save up to {MAX_IGNORE_RULES} ignore rules."
            ));
        }
        let key = rule_key(&title, &process_name);
        if rules
            .iter()
            .any(|r| rule_key(&r.title, &r.process_name) == key)
        {
            return Err("That rule is already in the ignore list.".into());
        }
        rules.push(WindowIgnoreRule {
            id: uuid::Uuid::new_v4().to_string(),
            title,
            process_name,
        });
        self.persist(&rules);
        Ok(rules.clone())
    }

    pub fn remove(&self, rule_id: &str) -> Result<Vec<WindowIgnoreRule>, String> {
        let id = rule_id.trim();
        if id.is_empty() || js_len(id) > MAX_IGNORE_RULE_ID_LENGTH {
            return Err("A valid rule id is required.".into());
        }
        let mut rules = self.rules.lock();
        rules.retain(|r| r.id != id);
        self.persist(&rules);
        Ok(rules.clone())
    }

    /// True when an equivalent rule (same fields, ignoring case) exists.
    pub fn contains(&self, title: &str, process_name: &str) -> bool {
        let key = rule_key(title, process_name);
        self.rules
            .lock()
            .iter()
            .any(|r| rule_key(&r.title, &r.process_name) == key)
    }

    fn persist(&self, rules: &[WindowIgnoreRule]) {
        if let Err(err) = json_store::write_atomic(&self.path, &json!({ "rules": rules })) {
            log::error!(
                "[window-switcher] writing {} failed: {err}",
                self.path.display()
            );
        }
    }
}

/// Case-insensitive comparison key: Windows executable names aren't
/// case-sensitive, and the same app can be reported as `Cs2.exe` or
/// `cs2.exe` depending on how it was launched.
fn bypass_key(process_name: &str) -> String {
    process_name.trim().to_lowercase()
}

fn sanitise_processes(value: Option<&Value>) -> Vec<String> {
    let Some(entries) = value.and_then(Value::as_array) else {
        return Vec::new();
    };
    let mut out = Vec::new();
    let mut seen = HashSet::new();
    for entry in entries {
        if out.len() >= MAX_BYPASS_PROCESSES {
            break;
        }
        let Some(name) = entry.as_str().map(str::trim) else {
            continue;
        };
        if name.is_empty() || js_len(name) > MAX_PROCESS_NAME_LENGTH {
            continue;
        }
        if seen.insert(bypass_key(name)) {
            out.push(name.to_owned());
        }
    }
    out
}

/// Executables that suspend keyboard remapping while they own the screen.
/// Mirrored into `runwa-core` on every write, because the check runs inside
/// the low-level keyboard hook.
pub struct FullscreenBypassStore {
    path: PathBuf,
    processes: Mutex<Vec<String>>,
}

impl FullscreenBypassStore {
    pub fn load(path: PathBuf) -> Self {
        let processes = sanitise_processes(
            json_store::read_object(&path)
                .as_ref()
                .and_then(|m| m.get("processes")),
        );
        runwa_core::set_remap_fullscreen_bypass(processes.clone());
        Self {
            path,
            processes: Mutex::new(processes),
        }
    }

    pub fn list(&self) -> Vec<String> {
        self.processes.lock().clone()
    }

    pub fn has(&self, process_name: &str) -> bool {
        let key = bypass_key(process_name);
        !key.is_empty() && self.processes.lock().iter().any(|p| bypass_key(p) == key)
    }

    /// Flip the flag for one executable; returns the new list and state.
    pub fn toggle(&self, process_name: &str) -> Result<(Vec<String>, bool), String> {
        let name = process_name.trim();
        if name.is_empty() {
            return Err("An executable name is required.".into());
        }
        if js_len(name) > MAX_PROCESS_NAME_LENGTH {
            return Err(format!(
                "Executable names can be at most {MAX_PROCESS_NAME_LENGTH} characters."
            ));
        }
        if self.has(name) {
            return Ok((self.remove(name), false));
        }
        let mut processes = self.processes.lock();
        if processes.len() >= MAX_BYPASS_PROCESSES {
            return Err(format!(
                "You can mark at most {MAX_BYPASS_PROCESSES} applications."
            ));
        }
        processes.push(name.to_owned());
        self.persist(&processes);
        Ok((processes.clone(), true))
    }

    pub fn remove(&self, process_name: &str) -> Vec<String> {
        let key = bypass_key(process_name);
        let mut processes = self.processes.lock();
        processes.retain(|p| bypass_key(p) != key);
        self.persist(&processes);
        processes.clone()
    }

    fn persist(&self, processes: &[String]) {
        if let Err(err) = json_store::write_atomic(&self.path, &json!({ "processes": processes })) {
            log::error!(
                "[keyboard-remap] writing {} failed: {err}",
                self.path.display()
            );
        }
        runwa_core::set_remap_fullscreen_bypass(processes.to_vec());
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn temp_path(name: &str) -> (PathBuf, PathBuf) {
        let dir = std::env::temp_dir().join(format!("runwa-stores-test-{}", uuid::Uuid::new_v4()));
        (dir.join(name), dir)
    }

    fn new_rule(title: &str, process_name: &str) -> NewWindowIgnoreRule {
        NewWindowIgnoreRule {
            title: Some(Value::String(title.into())),
            process_name: Some(Value::String(process_name.into())),
        }
    }

    #[test]
    fn ignore_rules_match_every_populated_field() {
        let rules = vec![
            WindowIgnoreRule {
                id: "1".into(),
                title: String::new(),
                process_name: "ktalk.exe".into(),
            },
            WindowIgnoreRule {
                id: "2".into(),
                title: "Telegram*".into(),
                process_name: String::new(),
            },
            WindowIgnoreRule {
                id: "3".into(),
                title: String::new(),
                process_name: String::new(),
            },
        ];
        assert!(is_window_ignored(&rules, "anything", "KTalk.exe"));
        assert!(is_window_ignored(
            &rules,
            "Telegram (26011)",
            "Telegram.exe"
        ));
        assert!(!is_window_ignored(&rules, "Chrome", "chrome.exe"));
    }

    #[test]
    fn ignore_store_validates_and_persists() {
        let (path, dir) = temp_path(IGNORE_FILE);
        let store = WindowIgnoreStore::load(path.clone());
        assert!(store.add(&new_rule("  ", "  ")).is_err());
        let rules = store.add(&new_rule(" Title ", "app.exe")).unwrap();
        assert_eq!(rules[0].title, "Title");
        assert!(
            store.add(&new_rule("title", "APP.EXE")).is_err(),
            "case-insensitive duplicate"
        );
        assert!(store.contains("TITLE", "app.exe"));

        let reloaded = WindowIgnoreStore::load(path);
        assert_eq!(reloaded.list(), rules);
        let rules = reloaded.remove(&rules[0].id).unwrap();
        assert!(rules.is_empty());
        std::fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn hand_edited_ignore_file_is_sanitised() {
        let (path, dir) = temp_path(IGNORE_FILE);
        json_store::write_atomic(
            &path,
            &json!({ "rules": [
                { "id": "a", "title": "x", "processName": "" },
                { "id": "a", "title": "dup id", "processName": "" },
                { "id": "b", "title": "X", "processName": "" },
                { "id": "c", "title": "", "processName": "" },
                { "title": "no id", "processName": "" },
                "garbage"
            ] }),
        )
        .unwrap();
        let store = WindowIgnoreStore::load(path);
        let ids: Vec<_> = store.list().into_iter().map(|r| r.id).collect();
        assert_eq!(ids, vec!["a"]);
        std::fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn bypass_store_toggles_case_insensitively() {
        let (path, dir) = temp_path(BYPASS_FILE);
        let store = FullscreenBypassStore::load(path.clone());
        let (list, enabled) = store.toggle("Cs2.exe").unwrap();
        assert!(enabled);
        assert_eq!(list, vec!["Cs2.exe"]);
        assert!(store.has("cs2.EXE"));
        let (list, enabled) = store.toggle("cs2.exe").unwrap();
        assert!(!enabled);
        assert!(list.is_empty());
        assert!(store.toggle("   ").is_err());

        store.toggle("game.exe").unwrap();
        assert_eq!(FullscreenBypassStore::load(path).list(), vec!["game.exe"]);
        std::fs::remove_dir_all(dir).unwrap();
    }
}
