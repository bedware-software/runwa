//! Rule schema and parsing.
//!
//! Rules are authored as JSON5 (JSON with comments) so users can annotate
//! the file on disk. After parsing, we canonicalise keys to an uppercase
//! ASCII form so the state machine can do simple HashMap lookups.

use serde::Deserialize;
use smallvec::SmallVec;
use std::collections::HashMap;

/// A logical modifier — platform-agnostic. Windows maps `Cmd` to `Win`,
/// macOS maps `Alt` to `Option`; `Super` is a synonym for `Cmd`/`Win`.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Modifier {
    Ctrl,
    Alt,
    Shift,
    Cmd,
    #[serde(alias = "win", alias = "super")]
    Win,
}

/// A key token as used in rules. Alphanumeric characters, functional keys,
/// and "Esc" / "Space" etc. Uppercased at parse time.
pub type KeyToken = String;

#[derive(Debug, Clone, Deserialize)]
pub struct Rules {
    #[serde(default = "default_true")]
    pub capslock_to_ctrl_escape: bool,

    #[serde(default)]
    pub space_layer: SpaceLayer,
}

fn default_true() -> bool {
    true
}

#[derive(Debug, Clone, Deserialize)]
pub struct SpaceLayer {
    #[serde(default = "default_true")]
    pub enabled: bool,

    /// When set, any unhandled Space-combo on macOS gets this modifier
    /// emitted in place of Space. Typically `cmd`.
    #[serde(default)]
    pub macos_transparent_modifier: Option<Modifier>,

    /// Same as above for Windows. Typically `None` — Windows lacks a
    /// universal Cmd-style shortcut layer.
    #[serde(default)]
    pub windows_transparent_modifier: Option<Modifier>,

    /// Explicit per-key overrides. Key format is case-insensitive, we
    /// uppercase at parse time. Special suffixes:
    ///   - `KEY_windows_only` — only applies on Windows
    ///   - `KEY_macos_only`   — only applies on macOS
    /// Without a suffix the override applies on both platforms.
    #[serde(default)]
    pub overrides: HashMap<String, Override>,
}

impl Default for SpaceLayer {
    fn default() -> Self {
        Self {
            enabled: true,
            macos_transparent_modifier: Some(Modifier::Cmd),
            windows_transparent_modifier: None,
            overrides: HashMap::new(),
        }
    }
}

/// A single override action. Fields are tried in order; exactly one must be
/// set.
#[derive(Debug, Clone, Deserialize)]
pub struct Override {
    /// Synthesize a key combination, e.g. `["Ctrl", "Alt", "W"]`. The last
    /// element must be the primary key; everything before is a modifier.
    pub synthesize: Vec<String>,
}

/// Fully-resolved, platform-specific rule set ready for the state machine.
#[derive(Debug, Clone)]
pub struct ResolvedRules {
    pub capslock_to_ctrl_escape: bool,
    pub space_layer_enabled: bool,
    pub transparent_modifier: Option<Modifier>,
    /// Keyed by uppercased token (e.g. `"W"`).
    pub space_overrides: HashMap<KeyToken, ResolvedAction>,
}

#[derive(Debug, Clone)]
pub struct ResolvedAction {
    pub modifiers: SmallVec<[Modifier; 4]>,
    pub key: KeyToken,
}

pub fn parse(json: &str) -> Result<ResolvedRules, String> {
    let rules: Rules = json5::from_str(json).map_err(|e| format!("{e}"))?;
    Ok(resolve(rules))
}

fn resolve(rules: Rules) -> ResolvedRules {
    #[cfg(target_os = "macos")]
    let transparent = rules.space_layer.macos_transparent_modifier;
    #[cfg(target_os = "windows")]
    let transparent = rules.space_layer.windows_transparent_modifier;
    #[cfg(not(any(target_os = "macos", target_os = "windows")))]
    let transparent = None::<Modifier>;

    #[cfg(target_os = "macos")]
    let platform_suffix = "_macos_only";
    #[cfg(target_os = "windows")]
    let platform_suffix = "_windows_only";
    #[cfg(not(any(target_os = "macos", target_os = "windows")))]
    let platform_suffix = "_linux_only";

    let mut space_overrides = HashMap::new();
    for (raw_key, ov) in rules.space_layer.overrides {
        let key_upper = raw_key.to_ascii_uppercase();
        // Reject other-platform suffixes; accept this-platform suffix or
        // no suffix at all.
        let effective_key = if let Some(idx) = key_upper.find('_') {
            let (prefix, suffix) = key_upper.split_at(idx);
            // Suffix is ASCII — case-insensitive compare.
            if suffix.eq_ignore_ascii_case(platform_suffix) {
                prefix.to_string()
            } else if suffix.eq_ignore_ascii_case("_windows_only")
                || suffix.eq_ignore_ascii_case("_macos_only")
                || suffix.eq_ignore_ascii_case("_linux_only")
            {
                // Suffix for a different platform → skip.
                continue;
            } else {
                // Some other underscore-bearing token — pass through as-is.
                key_upper.clone()
            }
        } else {
            key_upper.clone()
        };

        let Some(action) = resolve_action(&ov) else {
            continue;
        };
        space_overrides.insert(effective_key, action);
    }

    ResolvedRules {
        capslock_to_ctrl_escape: rules.capslock_to_ctrl_escape,
        space_layer_enabled: rules.space_layer.enabled,
        transparent_modifier: transparent,
        space_overrides,
    }
}

fn resolve_action(ov: &Override) -> Option<ResolvedAction> {
    if ov.synthesize.is_empty() {
        return None;
    }
    let (key, mods) = ov.synthesize.split_last()?;
    let mut modifiers: SmallVec<[Modifier; 4]> = SmallVec::new();
    for m in mods {
        match parse_modifier(m) {
            Some(md) => modifiers.push(md),
            None => return None,
        }
    }
    Some(ResolvedAction {
        modifiers,
        key: key.to_ascii_uppercase(),
    })
}

fn parse_modifier(s: &str) -> Option<Modifier> {
    match s.to_ascii_lowercase().as_str() {
        "ctrl" | "control" => Some(Modifier::Ctrl),
        "alt" | "option" | "opt" => Some(Modifier::Alt),
        "shift" => Some(Modifier::Shift),
        "cmd" | "command" | "win" | "super" | "meta" => {
            #[cfg(target_os = "macos")]
            {
                Some(Modifier::Cmd)
            }
            #[cfg(not(target_os = "macos"))]
            {
                Some(Modifier::Win)
            }
        }
        _ => None,
    }
}

/// Built-in default rules used when no user file exists yet. Kept in sync
/// with `DEFAULT_RULES_TEMPLATE` on the TS side; the TS template has
/// comments, this is the machine-readable copy for fallback parsing.
pub const DEFAULT_RULES_JSON: &str = r#"{
  "capslock_to_ctrl_escape": true,
  "space_layer": {
    "enabled": true,
    "macos_transparent_modifier": "cmd",
    "windows_transparent_modifier": null,
    "overrides": {
      "Q_windows_only": { "synthesize": ["Alt", "F4"] }
    }
  }
}"#;

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_default_json() {
        let r = parse(DEFAULT_RULES_JSON).expect("default rules parse");
        assert!(r.capslock_to_ctrl_escape);
        assert!(r.space_layer_enabled);
    }

    #[test]
    fn parses_json5_with_comments() {
        let src = r#"
            // top-level comment
            {
              capslock_to_ctrl_escape: true,
              space_layer: {
                enabled: true,
                overrides: {
                  // inline
                  "W": { synthesize: ["Ctrl", "Alt", "W"] }
                }
              }
            }
        "#;
        let r = parse(src).expect("json5 parse");
        assert!(r.space_overrides.contains_key("W"));
    }

    #[test]
    fn uppercases_override_keys() {
        let src = r#"{
          "space_layer": {
            "overrides": {
              "w": { "synthesize": ["Ctrl", "Alt", "W"] }
            }
          }
        }"#;
        let r = parse(src).unwrap();
        assert!(r.space_overrides.contains_key("W"));
    }

    #[test]
    fn synthesize_parses_modifiers_and_key() {
        let src = r#"{
          "space_layer": {
            "overrides": {
              "W": { "synthesize": ["Ctrl", "Alt", "W"] }
            }
          }
        }"#;
        let r = parse(src).unwrap();
        let action = r.space_overrides.get("W").unwrap();
        assert_eq!(action.key, "W");
        assert_eq!(action.modifiers.as_slice(), &[Modifier::Ctrl, Modifier::Alt]);
    }
}
