//! Settings store — the Rust port of `src/main/settings-store.ts`.
//!
//! Same file (`runwa-settings.json`), same shape, same merge rules, so the
//! renderer's `Settings` type and the Electron build both keep working on
//! whatever this writes. The store keeps the raw JSON object rather than a
//! typed struct: keys this shell doesn't know yet (settings of modules that
//! haven't been ported) must survive a round trip untouched.
//!
//! Patches arrive from the renderer as JSON, where `undefined` can't be
//! expressed — the bridge turns it into `null`, and every merge here treats
//! `null` as "remove this key", which is what `{ ...a, ...{ k: undefined } }`
//! followed by a JSON write amounted to on the Electron side.

use std::path::PathBuf;

use parking_lot::Mutex;
use serde::Serialize;
use serde_json::{json, Map, Value};

use crate::json_store;

pub const SETTINGS_FILE: &str = "runwa-settings.json";

/// `DEFAULT_SETTINGS` from `src/shared/types.ts`.
fn defaults() -> Map<String, Value> {
    match json!({
        "theme": "system",
        "quickLaunchDigitsRequireAlt": false,
        "paletteSwitchToEnglish": true,
        "startAtLogin": false,
        "runAsAdmin": false,
        "modules": {}
    }) {
        Value::Object(map) => map,
        _ => unreachable!(),
    }
}

/// Snapshot of the whole settings object, as sent to the renderer.
#[derive(Clone, Debug, Serialize)]
#[serde(transparent)]
pub struct Settings(pub Map<String, Value>);

impl Settings {
    pub fn theme(&self) -> &str {
        self.0
            .get("theme")
            .and_then(Value::as_str)
            .unwrap_or("system")
    }

    pub fn bool_or(&self, key: &str, default: bool) -> bool {
        self.0.get(key).and_then(Value::as_bool).unwrap_or(default)
    }

    pub fn palette_size(&self) -> Option<(f64, f64)> {
        let size = self.0.get("paletteSize")?;
        Some((size.get("width")?.as_f64()?, size.get("height")?.as_f64()?))
    }

    pub fn palette_position(&self) -> Option<(f64, f64)> {
        let pos = self.0.get("palettePosition")?;
        Some((pos.get("x")?.as_f64()?, pos.get("y")?.as_f64()?))
    }

    pub fn module(&self, id: &str) -> Option<&Map<String, Value>> {
        self.0.get("modules")?.get(id)?.as_object()
    }

    pub fn module_enabled(&self, id: &str, default: bool) -> bool {
        self.module(id)
            .and_then(|m| m.get("enabled"))
            .and_then(Value::as_bool)
            .unwrap_or(default)
    }

    pub fn module_hotkey(&self, id: &str) -> Option<String> {
        let hotkey = self.module(id)?.get("directLaunchHotkey")?.as_str()?.trim();
        (!hotkey.is_empty()).then(|| hotkey.to_owned())
    }

    pub fn module_config(&self, id: &str) -> Map<String, Value> {
        self.module(id)
            .and_then(|m| m.get("config"))
            .and_then(Value::as_object)
            .cloned()
            .unwrap_or_default()
    }

    pub fn module_aliases(&self, id: &str) -> Map<String, Value> {
        self.module(id)
            .and_then(|m| m.get("aliases"))
            .and_then(Value::as_object)
            .cloned()
            .unwrap_or_default()
    }

    pub fn module_elevated(&self, id: &str) -> Vec<String> {
        self.module(id)
            .and_then(|m| m.get("elevated"))
            .and_then(Value::as_array)
            .map(|ids| {
                ids.iter()
                    .filter_map(|v| v.as_str().map(str::to_owned))
                    .collect()
            })
            .unwrap_or_default()
    }
}

pub struct SettingsStore {
    path: PathBuf,
    data: Mutex<Map<String, Value>>,
}

impl SettingsStore {
    /// Load the store, writing the defaults back when any top-level key was
    /// missing — electron-store does the same on construction.
    pub fn load(path: PathBuf) -> Self {
        let stored = json_store::read_object(&path);
        let existed = stored.is_some();
        let mut data = stored.unwrap_or_default();
        let mut changed = false;
        for (key, value) in defaults() {
            if !data.contains_key(&key) {
                data.insert(key, value);
                changed = true;
            }
        }
        let store = Self {
            path,
            data: Mutex::new(data),
        };
        if changed || !existed {
            store.persist(&store.data.lock());
        }
        store
    }

    pub fn get(&self) -> Settings {
        Settings(snapshot(&self.data.lock()))
    }

    /// `settingsStore.patch` — replace top-level keys, merge `modules` one
    /// level deep.
    pub fn patch(&self, mut partial: Map<String, Value>) -> Settings {
        self.mutate(|data| {
            let partial_modules = partial.remove("modules");
            merge(data, partial);
            if let Some(Value::Object(modules)) = partial_modules {
                merge(modules_mut(data), modules);
            }
        })
    }

    /// `settingsStore.patchModule` — shallow-merge a module's entry, with its
    /// `config` bag merged one level deeper so a partial update can't
    /// clobber sibling keys.
    pub fn patch_module(&self, module_id: &str, mut patch: Map<String, Value>) -> Settings {
        self.mutate(|data| {
            let module = module_mut(data, module_id);
            let config_patch = patch.remove("config");
            merge(module, patch);
            if let Some(Value::Object(config_patch)) = config_patch {
                let config = module
                    .entry("config")
                    .or_insert_with(|| Value::Object(Map::new()));
                if !config.is_object() {
                    *config = Value::Object(Map::new());
                }
                if let Value::Object(config) = config {
                    merge(config, config_patch);
                }
            }
        })
    }

    pub fn patch_module_config(
        &self,
        module_id: &str,
        config_patch: Map<String, Value>,
    ) -> Settings {
        let mut patch = Map::new();
        patch.insert("config".into(), Value::Object(config_patch));
        self.patch_module(module_id, patch)
    }

    /// Set or clear one alias. Trimmed and lowercased; an empty result
    /// removes the entry so the stored map stays compact.
    pub fn patch_module_alias(
        &self,
        module_id: &str,
        item_id: &str,
        alias: Option<&str>,
    ) -> Settings {
        let normalised = alias.map(|a| a.trim().to_lowercase()).unwrap_or_default();
        self.mutate(|data| {
            let module = module_mut(data, module_id);
            let aliases = object_entry(module, "aliases");
            if normalised.is_empty() {
                aliases.remove(item_id);
            } else {
                aliases.insert(item_id.to_owned(), Value::String(normalised.clone()));
            }
        })
    }

    /// Add or remove one item from a module's "launch elevated" list.
    pub fn patch_module_elevated(
        &self,
        module_id: &str,
        item_id: &str,
        elevated: bool,
    ) -> Settings {
        self.mutate(|data| {
            let module = module_mut(data, module_id);
            let mut ids: Vec<Value> = module
                .get("elevated")
                .and_then(Value::as_array)
                .map(|ids| {
                    ids.iter()
                        .filter(|v| v.as_str() != Some(item_id))
                        .cloned()
                        .collect()
                })
                .unwrap_or_default();
            if elevated {
                ids.push(Value::String(item_id.to_owned()));
            }
            module.insert("elevated".into(), Value::Array(ids));
        })
    }

    /// Seed a module's entry on first registration, and back-fill config
    /// keys added to its manifest since the entry was written — without
    /// touching values the user already chose (including a cleared hotkey).
    /// Returns `None` when nothing had to change.
    pub fn ensure_module_defaults(
        &self,
        module_id: &str,
        defaults: Map<String, Value>,
    ) -> Option<Settings> {
        let current = self.get();
        let Some(existing) = current.module(module_id) else {
            return Some(self.patch_module(module_id, defaults));
        };
        let existing_config = existing
            .get("config")
            .and_then(Value::as_object)
            .cloned()
            .unwrap_or_default();
        let missing: Map<String, Value> = defaults
            .get("config")
            .and_then(Value::as_object)
            .map(|config| {
                config
                    .iter()
                    .filter(|(key, _)| !existing_config.contains_key(*key))
                    .map(|(key, value)| (key.clone(), value.clone()))
                    .collect()
            })
            .unwrap_or_default();
        (!missing.is_empty()).then(|| self.patch_module_config(module_id, missing))
    }

    fn mutate(&self, f: impl FnOnce(&mut Map<String, Value>)) -> Settings {
        let mut data = self.data.lock();
        f(&mut data);
        self.persist(&data);
        Settings(snapshot(&data))
    }

    fn persist(&self, data: &Map<String, Value>) {
        if let Err(err) = json_store::write_atomic(&self.path, data) {
            log::error!("[settings] writing {} failed: {err}", self.path.display());
        }
    }
}

/// `{ ...DEFAULT_SETTINGS, ...stored, modules: { ...stored.modules } }`.
fn snapshot(data: &Map<String, Value>) -> Map<String, Value> {
    let mut out = defaults();
    for (key, value) in data {
        out.insert(key.clone(), value.clone());
    }
    if !out.get("modules").is_some_and(Value::is_object) {
        out.insert("modules".into(), Value::Object(Map::new()));
    }
    out
}

/// Shallow merge with `null` meaning "delete".
fn merge(target: &mut Map<String, Value>, patch: Map<String, Value>) {
    for (key, value) in patch {
        if value.is_null() {
            target.remove(&key);
        } else {
            target.insert(key, value);
        }
    }
}

fn object_entry<'a>(map: &'a mut Map<String, Value>, key: &str) -> &'a mut Map<String, Value> {
    let entry = map
        .entry(key.to_owned())
        .or_insert_with(|| Value::Object(Map::new()));
    if !entry.is_object() {
        *entry = Value::Object(Map::new());
    }
    match entry {
        Value::Object(map) => map,
        _ => unreachable!(),
    }
}

fn modules_mut(data: &mut Map<String, Value>) -> &mut Map<String, Value> {
    object_entry(data, "modules")
}

/// A module's entry, created as `{ enabled: false }` when missing — the
/// fallback `settingsStore.patchModule` used.
fn module_mut<'a>(data: &'a mut Map<String, Value>, module_id: &str) -> &'a mut Map<String, Value> {
    let modules = modules_mut(data);
    if !modules.get(module_id).is_some_and(Value::is_object) {
        modules.insert(module_id.to_owned(), json!({ "enabled": false }));
    }
    match modules.get_mut(module_id) {
        Some(Value::Object(module)) => module,
        _ => unreachable!(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn temp_store() -> (SettingsStore, PathBuf) {
        let dir =
            std::env::temp_dir().join(format!("runwa-settings-test-{}", uuid::Uuid::new_v4()));
        let path = dir.join(SETTINGS_FILE);
        (SettingsStore::load(path), dir)
    }

    fn obj(value: Value) -> Map<String, Value> {
        value.as_object().cloned().unwrap()
    }

    #[test]
    fn fresh_store_has_defaults_on_disk() {
        let (store, dir) = temp_store();
        let settings = store.get();
        assert_eq!(settings.theme(), "system");
        assert!(settings.bool_or("paletteSwitchToEnglish", false));
        let on_disk = json_store::read_object(&dir.join(SETTINGS_FILE)).unwrap();
        assert_eq!(on_disk.get("theme"), Some(&json!("system")));
        std::fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn patch_merges_modules_and_null_deletes() {
        let (store, dir) = temp_store();
        store.patch(obj(
            json!({ "paletteSize": { "width": 800, "height": 600 } }),
        ));
        store.patch_module(
            "a",
            obj(json!({ "enabled": true, "directLaunchHotkey": "Ctrl+Alt+A" })),
        );
        store.patch_module("b", obj(json!({ "enabled": true })));
        // A partial `modules` patch keeps sibling modules.
        let settings = store.patch(obj(json!({ "modules": { "b": { "enabled": false } } })));
        assert!(settings.module_enabled("a", false));
        assert!(!settings.module_enabled("b", true));
        assert_eq!(settings.palette_size(), Some((800.0, 600.0)));

        // `{ directLaunchHotkey: undefined }` arrives as null → cleared.
        let settings = store.patch_module("a", obj(json!({ "directLaunchHotkey": null })));
        assert_eq!(settings.module_hotkey("a"), None);
        assert!(settings.module_enabled("a", false));
        std::fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn module_config_merges_one_level_deeper() {
        let (store, dir) = temp_store();
        store.patch_module_config("m", obj(json!({ "x": true, "y": "keep" })));
        let settings = store.patch_module_config("m", obj(json!({ "x": false })));
        let config = settings.module_config("m");
        assert_eq!(config.get("x"), Some(&json!(false)));
        assert_eq!(config.get("y"), Some(&json!("keep")));
        // A module created by a config patch starts disabled, as in TS.
        assert!(!settings.module_enabled("m", true));
        std::fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn aliases_are_normalised_and_removable() {
        let (store, dir) = temp_store();
        let settings = store.patch_module_alias("m", "item", Some("  VS  "));
        assert_eq!(settings.module_aliases("m").get("item"), Some(&json!("vs")));
        let settings = store.patch_module_alias("m", "item", Some("   "));
        assert!(settings.module_aliases("m").is_empty());
        std::fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn elevated_list_toggles_without_duplicates() {
        let (store, dir) = temp_store();
        store.patch_module_elevated("m", "a", true);
        store.patch_module_elevated("m", "a", true);
        let settings = store.patch_module_elevated("m", "b", true);
        assert_eq!(settings.module_elevated("m"), vec!["a", "b"]);
        let settings = store.patch_module_elevated("m", "a", false);
        assert_eq!(settings.module_elevated("m"), vec!["b"]);
        std::fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn ensure_defaults_seeds_once_and_backfills_config() {
        let (store, dir) = temp_store();
        let defaults = obj(json!({
            "enabled": true,
            "directLaunchHotkey": "Ctrl+Alt+W",
            "config": { "a": true }
        }));
        assert!(store
            .ensure_module_defaults("m", defaults.clone())
            .is_some());
        // The user clears the hotkey and flips `a`…
        store.patch_module("m", obj(json!({ "directLaunchHotkey": null })));
        store.patch_module_config("m", obj(json!({ "a": false })));
        // …a restart must not resurrect either, but a new key is back-filled.
        let mut upgraded = defaults;
        upgraded.insert("config".into(), json!({ "a": true, "b": "new" }));
        let settings = store.ensure_module_defaults("m", upgraded).unwrap();
        assert_eq!(settings.module_hotkey("m"), None);
        assert_eq!(settings.module_config("m").get("a"), Some(&json!(false)));
        assert_eq!(settings.module_config("m").get("b"), Some(&json!("new")));
        std::fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn unknown_keys_survive_a_round_trip() {
        let (store, dir) = temp_store();
        store.patch(obj(json!({ "futureSetting": { "nested": 1 } })));
        store.patch_module(
            "unported",
            obj(json!({ "enabled": true, "config": { "k": "v" } })),
        );
        let reloaded = SettingsStore::load(dir.join(SETTINGS_FILE));
        let settings = reloaded.get();
        assert_eq!(
            settings.0.get("futureSetting"),
            Some(&json!({ "nested": 1 }))
        );
        assert_eq!(
            settings.module_config("unported").get("k"),
            Some(&json!("v"))
        );
        std::fs::remove_dir_all(dir).unwrap();
    }
}
