//! Rust mirrors of the IPC shapes in `src/shared/types.ts`.
//!
//! Field names are camelCase on the wire, exactly as the renderer already
//! sends and expects them over Electron IPC. Anything the renderer treats
//! as opaque (`PaletteItem.action`, confirm dialogs) stays a JSON value.

use serde::{Deserialize, Serialize};
use serde_json::{Map, Value};

pub type ModuleId = String;

/// One palette row. Received back from the renderer on execute / close /
/// ignore, so every optional field tolerates being absent, and the owning
/// module re-validates `action_kind` + `action` before acting on them.
#[derive(Clone, Debug, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PaletteItem {
    pub id: String,
    #[serde(default)]
    pub module_id: ModuleId,
    #[serde(default)]
    pub title: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub subtitle: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub icon_hint: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub icon_tooltip: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub icon_badge: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub reveal_path: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub auto_execute: Option<bool>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub alias: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub badge: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub group: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub confirm: Option<Value>,
    #[serde(default)]
    pub action_kind: String,
    #[serde(default)]
    pub action: Value,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub score: Option<f64>,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SearchRequest {
    pub request_id: f64,
    #[serde(default)]
    pub query: String,
    #[serde(default)]
    pub scope_module_id: Option<ModuleId>,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SearchResult {
    pub request_id: f64,
    pub items: Vec<PaletteItem>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub resolved_module_id: Option<ModuleId>,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ExecuteResult {
    pub dismiss_palette: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PaletteShowPayload {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub initial_module_id: Option<ModuleId>,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AppInfo {
    pub is_packaged: bool,
    /// Node's `process.platform` vocabulary — the renderer compares against
    /// `'win32'` / `'darwin'`.
    pub platform: &'static str,
    pub version: String,
    pub name: String,
    pub user_data_path: String,
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct WindowIgnoreRule {
    pub id: String,
    pub title: String,
    pub process_name: String,
}

#[derive(Clone, Debug, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct NewWindowIgnoreRule {
    #[serde(default)]
    pub title: Option<Value>,
    #[serde(default)]
    pub process_name: Option<Value>,
}

#[derive(Clone, Copy, Debug, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum WindowIgnoreScope {
    Window,
    Process,
}

#[derive(Clone, Copy, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PermissionFlags {
    pub accessibility: bool,
    pub screen_recording: bool,
}

#[derive(Clone, Copy, Debug, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum PermissionName {
    Accessibility,
    ScreenRecording,
}

/// `ModuleManifest` minus the runtime fields. Built once per module.
#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ModuleManifest {
    pub id: ModuleId,
    pub name: String,
    pub icon: String,
    pub kind: ModuleKind,
    pub description: String,
    pub default_enabled: bool,
    pub supports_direct_launch: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub default_direct_launch_hotkey: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub direct_launch_second_press: Option<SecondPress>,
    #[serde(skip_serializing_if = "Vec::is_empty")]
    pub config_fields: Vec<ConfigField>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub default_aliases: Option<Map<String, Value>>,
}

#[derive(Clone, Copy, Debug, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum ModuleKind {
    Search,
    #[allow(dead_code)] // no service module is ported yet
    Service,
}

/// What a second press of a module's hotkey does while its palette is up.
#[derive(Clone, Copy, Debug, Default, Serialize, PartialEq, Eq)]
#[serde(rename_all = "kebab-case")]
pub enum SecondPress {
    #[default]
    Dismiss,
    ActivateSecond,
}

/// One entry of a module's declarative settings schema. A flat struct with
/// optional members serializes to the same JSON as the TypeScript union
/// (`checkbox | radio | text | action`), without a serde enum per variant.
#[derive(Clone, Debug, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ConfigField {
    #[serde(rename = "type")]
    pub kind: &'static str,
    pub key: String,
    pub label: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub description: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub os: Option<&'static str>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub group: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub default_value: Option<Value>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub read_only: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub secret: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub placeholder: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub multiline: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub button_label: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub icon: Option<String>,
}

impl ConfigField {
    pub fn checkbox(key: &str, label: &str, description: &str, default_value: bool) -> Self {
        Self {
            kind: "checkbox",
            key: key.into(),
            label: label.into(),
            description: Some(description.into()),
            default_value: Some(Value::Bool(default_value)),
            ..Self::default()
        }
    }
}
