//! Palette modules and their registry — port of `src/main/modules/types.ts`
//! and `registry.ts`.
//!
//! Registration order is what the settings sidebar shows. Only the Window
//! Switcher is ported so far; the Electron build's other modules keep their
//! stored settings untouched (the settings store round-trips unknown keys)
//! and simply don't appear here until they land.

pub mod window_switcher;

use serde_json::{Map, Value};
use tauri::AppHandle;

use crate::focus::FocusedApp;
use crate::settings::{Settings, SettingsStore};
use crate::types::{ExecuteResult, ModuleManifest, PaletteItem, SearchRequest, SearchResult};

/// Rows the registry keeps after sorting a module's results.
pub const MAX_RESULTS: usize = 100;

pub struct SearchContext<'a> {
    /// Current config values for this module, merged with defaults.
    pub config: Map<String, Value>,
    /// User-assigned aliases keyed by the module's stable entry ids.
    #[allow(dead_code)] // read by App Search / User Commands once ported
    pub aliases: Map<String, Value>,
    /// Item ids marked "run as administrator".
    #[allow(dead_code)]
    pub elevated: Vec<String>,
    /// The app behind the palette, resolved lazily on first use.
    #[allow(dead_code)]
    pub focused_app: &'a dyn Fn() -> Option<FocusedApp>,
}

pub struct ExecuteOutcome {
    pub dismiss_palette: bool,
}

pub trait PaletteModule: Send + Sync {
    fn manifest(&self) -> &ModuleManifest;

    /// Matches for a query. `module_id` is stamped by the registry, so a
    /// module can't claim another module's rows.
    fn search(&self, app: &AppHandle, query: &str, context: &SearchContext<'_>)
        -> Vec<PaletteItem>;

    /// Execute a row the renderer sent back. The item crossed IPC, so the
    /// module must re-validate `action_kind` and `action` first.
    fn execute(&self, app: &AppHandle, item: &PaletteItem) -> Result<ExecuteOutcome, String>;

    /// Click on a `type: 'action'` config field.
    fn on_action(&self, _app: &AppHandle, _key: &str) -> Result<(), String> {
        Ok(())
    }
}

pub struct ModuleRegistry {
    modules: Vec<Box<dyn PaletteModule>>,
}

fn default_config(manifest: &ModuleManifest) -> Map<String, Value> {
    manifest
        .config_fields
        .iter()
        .filter_map(|field| Some((field.key.clone(), field.default_value.clone()?)))
        .collect()
}

impl ModuleRegistry {
    /// Build the registry and seed each module's settings entry on first
    /// registration (`ensureModuleDefaults`). Existing users keep their
    /// bindings, including a deliberately cleared hotkey.
    pub fn new(modules: Vec<Box<dyn PaletteModule>>, settings: &SettingsStore) -> Self {
        for module in &modules {
            let manifest = module.manifest();
            let mut defaults = Map::new();
            defaults.insert("enabled".into(), Value::Bool(manifest.default_enabled));
            defaults.insert("config".into(), Value::Object(default_config(manifest)));
            if manifest.supports_direct_launch {
                if let Some(hotkey) = &manifest.default_direct_launch_hotkey {
                    defaults.insert("directLaunchHotkey".into(), Value::String(hotkey.clone()));
                }
            }
            if let Some(aliases) = &manifest.default_aliases {
                defaults.insert("aliases".into(), Value::Object(aliases.clone()));
            }
            settings.ensure_module_defaults(&manifest.id, defaults);
        }
        Self { modules }
    }

    pub fn get(&self, id: &str) -> Option<&dyn PaletteModule> {
        self.modules
            .iter()
            .find(|m| m.manifest().id == id)
            .map(|m| m.as_ref())
    }

    pub fn iter(&self) -> impl Iterator<Item = &dyn PaletteModule> {
        self.modules.iter().map(|m| m.as_ref())
    }

    fn effective_config(module: &dyn PaletteModule, settings: &Settings) -> Map<String, Value> {
        let manifest = module.manifest();
        let mut config = default_config(manifest);
        for (key, value) in settings.module_config(&manifest.id) {
            config.insert(key, value);
        }
        config
    }

    /// `ModuleMeta[]` — manifests plus the user's runtime state.
    pub fn manifests(&self, settings: &Settings) -> Vec<Value> {
        self.iter()
            .map(|module| {
                let manifest = module.manifest();
                let mut meta = match serde_json::to_value(manifest) {
                    Ok(Value::Object(map)) => map,
                    _ => Map::new(),
                };
                meta.insert(
                    "enabled".into(),
                    Value::Bool(settings.module_enabled(&manifest.id, manifest.default_enabled)),
                );
                if let Some(hotkey) = settings
                    .module(&manifest.id)
                    .and_then(|m| m.get("directLaunchHotkey"))
                    .and_then(Value::as_str)
                {
                    meta.insert(
                        "directLaunchHotkey".into(),
                        Value::String(hotkey.to_owned()),
                    );
                }
                meta.insert(
                    "config".into(),
                    Value::Object(Self::effective_config(module, settings)),
                );
                meta.insert(
                    "aliases".into(),
                    Value::Object(settings.module_aliases(&manifest.id)),
                );
                meta.insert(
                    "elevated".into(),
                    Value::Array(
                        settings
                            .module_elevated(&manifest.id)
                            .into_iter()
                            .map(Value::String)
                            .collect(),
                    ),
                );
                Value::Object(meta)
            })
            .collect()
    }

    /// Every palette session is scoped to one module; a request without a
    /// target returns nothing rather than synthesising a picker.
    pub fn search(
        &self,
        app: &AppHandle,
        settings: &Settings,
        request: &SearchRequest,
        focused_app: &dyn Fn() -> Option<FocusedApp>,
    ) -> SearchResult {
        let Some(scope) = request.scope_module_id.clone() else {
            return SearchResult {
                request_id: request.request_id,
                items: Vec::new(),
                resolved_module_id: None,
            };
        };
        let Some(module) = self.get(&scope) else {
            return SearchResult {
                request_id: request.request_id,
                items: Vec::new(),
                resolved_module_id: Some(scope),
            };
        };

        let context = SearchContext {
            config: Self::effective_config(module, settings),
            aliases: settings.module_aliases(&scope),
            elevated: settings.module_elevated(&scope),
            focused_app,
        };
        let mut items = module.search(app, &request.query, &context);
        for item in &mut items {
            item.module_id = scope.clone();
        }
        // Stable sort, ascending score (0 = best), like the TS registry.
        items.sort_by(|a, b| {
            a.score
                .unwrap_or(0.0)
                .partial_cmp(&b.score.unwrap_or(0.0))
                .unwrap_or(std::cmp::Ordering::Equal)
        });
        items.truncate(MAX_RESULTS);

        SearchResult {
            request_id: request.request_id,
            items,
            resolved_module_id: Some(scope),
        }
    }

    pub fn execute(&self, app: &AppHandle, item: &PaletteItem) -> ExecuteResult {
        let Some(module) = self.get(&item.module_id) else {
            return ExecuteResult {
                dismiss_palette: false,
                error: Some(format!("unknown module: {}", item.module_id)),
            };
        };
        match module.execute(app, item) {
            Ok(outcome) => ExecuteResult {
                dismiss_palette: outcome.dismiss_palette,
                error: None,
            },
            Err(err) => {
                log::warn!("[registry] execute failed for {}: {err}", item.module_id);
                ExecuteResult {
                    dismiss_palette: false,
                    error: Some(err),
                }
            }
        }
    }

    pub fn action(&self, app: &AppHandle, module_id: &str, key: &str) {
        let Some(module) = self.get(module_id) else {
            return;
        };
        if let Err(err) = module.on_action(app, key) {
            log::warn!("[registry] action {module_id}.{key} failed: {err}");
        }
    }
}
