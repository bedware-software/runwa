//! Rule schema v2.
//!
//! YAML config maps each physical trigger key (`capslock`, `space`) to a
//! dual-role remap: what happens on tap (press-release alone) vs on hold
//! (press-and-interrupt-with-another-key). Presence of a trigger block is
//! what enables it; omit it and the key behaves normally.
//!
//! ```yaml
//! capslock:
//!   to_hotkey:
//!     on_tap: escape
//!     on_hold: ctrl
//!
//! space:
//!   to_hotkey:
//!     on_tap: space
//!     on_hold:
//!       - description: Space+W opens Window Switcher
//!         keys: [w]
//!         to_hotkey: [ctrl, alt, s]
//!       - description: transparent Cmd for unmapped combos (macOS only)
//!         platform: macos
//!         keys: [_default]
//!         to_hotkey: [cmd]
//! ```

use serde::Deserialize;
use smallvec::SmallVec;
use std::collections::HashMap;

// ---------------------------------------------------------------------------
// Public data shapes (logical modifiers / pre-baked synthetic events).

/// Platform-agnostic modifier. `Cmd`/`Win` are treated as the same logical
/// modifier at emit time (Cmd on macOS, Win on Windows).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub enum Modifier {
    Ctrl,
    Alt,
    Shift,
    Cmd,
    Win,
}

/// Named physical keys we can both match on and synthesize.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum NamedKey {
    Escape,
    Space,
    Tab,
    Return,
    Delete,
    F1,
    F2,
    F3,
    F4,
    F5,
    F6,
    F7,
    F8,
    F9,
    F10,
    F11,
    F12,
    /// An uppercase ASCII alpha (A–Z) or digit (0–9). Stored as the ASCII
    /// byte so callers can match/synth uniformly.
    Alpha(u8),
}

/// A single synthetic keyboard event the platform layer should inject.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum SyntheticEvent {
    ModifierDown(Modifier),
    ModifierUp(Modifier),
    KeyDown(NamedKey),
    KeyUp(NamedKey),
}

// ---------------------------------------------------------------------------
// Resolved form — what the state machine consumes.

#[derive(Debug, Clone, Default)]
pub struct ResolvedRules {
    pub capslock: Option<ResolvedBinding>,
    pub space: Option<ResolvedBinding>,
}

#[derive(Debug, Clone)]
pub struct ResolvedBinding {
    /// Events emitted when the trigger is pressed and released with no
    /// other key in between. `None` = no-op.
    pub on_tap: Option<Vec<SyntheticEvent>>,
    pub on_hold: ResolvedHold,
}

#[derive(Debug, Clone)]
pub enum ResolvedHold {
    /// While the trigger is held, it acts as this logical modifier.
    TransparentModifier(Modifier),
    /// Explicit per-combo overrides. Key is the uppercase single-char
    /// token (e.g. "W", "1"). Value is the pre-baked event sequence.
    Explicit {
        overrides: HashMap<String, Vec<SyntheticEvent>>,
        /// Fallback modifier for unmapped combos. Sourced from a rule
        /// whose `keys: [_default]` + `to_hotkey: [<modifier>]`.
        fallback: Option<Modifier>,
    },
    /// Hold does nothing special — behave as the raw key. Used when the
    /// user wants to remap only `on_tap` without a layer.
    Passthrough,
}

// ---------------------------------------------------------------------------
// Wire format — deserialized directly from YAML.

#[derive(Debug, Deserialize, Default)]
#[serde(deny_unknown_fields)]
struct Config {
    #[serde(default)]
    capslock: Option<KeyRemap>,
    #[serde(default)]
    space: Option<KeyRemap>,
}

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
struct KeyRemap {
    to_hotkey: ToHotkey,
}

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
struct ToHotkey {
    #[serde(default)]
    on_tap: Option<TapSpec>,
    #[serde(default)]
    on_hold: Option<HoldSpec>,
}

/// `on_tap` = a single key name OR a list of tokens forming a hotkey combo.
#[derive(Debug, Deserialize)]
#[serde(untagged)]
enum TapSpec {
    Single(String),
    Combo(Vec<String>),
}

/// `on_hold` = a scalar modifier name (transparent) OR a list of rules.
#[derive(Debug, Deserialize)]
#[serde(untagged)]
enum HoldSpec {
    Transparent(String),
    Rules(Vec<HoldRule>),
}

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
struct HoldRule {
    #[serde(default)]
    description: Option<String>,
    #[serde(default)]
    platform: Option<String>,
    keys: Vec<String>,
    to_hotkey: Vec<String>,
}

// ---------------------------------------------------------------------------
// Parse + resolve

pub fn parse(yaml: &str) -> Result<ResolvedRules, String> {
    let cfg: Config = serde_yml::from_str(yaml).map_err(|e| format!("{e}"))?;
    Ok(ResolvedRules {
        capslock: cfg.capslock.map(|c| resolve_binding(&c)).transpose()?,
        space: cfg.space.map(|c| resolve_binding(&c)).transpose()?,
    })
}

fn resolve_binding(remap: &KeyRemap) -> Result<ResolvedBinding, String> {
    let on_tap = match &remap.to_hotkey.on_tap {
        Some(TapSpec::Single(s)) => Some(bake_hotkey_tokens(std::slice::from_ref(s))?),
        Some(TapSpec::Combo(items)) => Some(bake_hotkey_tokens(items.as_slice())?),
        None => None,
    };

    let on_hold = match &remap.to_hotkey.on_hold {
        None => ResolvedHold::Passthrough,
        Some(HoldSpec::Transparent(name)) => match parse_modifier(name) {
            Some(m) => ResolvedHold::TransparentModifier(m),
            None => {
                return Err(format!(
                    "on_hold '{name}' is not a recognised modifier name"
                ))
            }
        },
        Some(HoldSpec::Rules(list)) => {
            let mut overrides: HashMap<String, Vec<SyntheticEvent>> = HashMap::new();
            let mut fallback: Option<Modifier> = None;

            for rule in list {
                // Platform gate.
                if let Some(p) = &rule.platform {
                    if !platform_matches(p) {
                        continue;
                    }
                }

                // Multi-key triggers aren't supported yet — warn-and-skip so
                // users can author forward-compatible rules without breaking
                // the current engine.
                if rule.keys.len() != 1 {
                    eprintln!(
                        "[keyboard-remap] skipping rule '{}': multi-key triggers (len {}) not supported yet",
                        rule.description.as_deref().unwrap_or("<unnamed>"),
                        rule.keys.len()
                    );
                    continue;
                }

                let trigger_raw = &rule.keys[0];
                let trigger_token = trigger_raw.to_ascii_uppercase();

                if trigger_token == "_DEFAULT" {
                    // Fallback must be a single-modifier entry.
                    if rule.to_hotkey.len() != 1 {
                        return Err(format!(
                            "rule with keys: [_default] must have to_hotkey = a single modifier, got {:?}",
                            rule.to_hotkey
                        ));
                    }
                    match parse_modifier(&rule.to_hotkey[0]) {
                        Some(m) => fallback = Some(m),
                        None => {
                            return Err(format!(
                                "rule with keys: [_default] has unknown modifier '{}'",
                                rule.to_hotkey[0]
                            ))
                        }
                    }
                    continue;
                }

                let events = bake_hotkey_tokens(rule.to_hotkey.as_slice())?;
                overrides.insert(trigger_token, events);
            }

            ResolvedHold::Explicit { overrides, fallback }
        }
    };

    Ok(ResolvedBinding { on_tap, on_hold })
}

/// Pre-bake a hotkey token list into a synthetic event sequence. Every
/// entry is a modifier except (optionally) the last — which may be a
/// named key or a single alpha.
fn bake_hotkey_tokens(tokens: &[String]) -> Result<Vec<SyntheticEvent>, String> {
    if tokens.is_empty() {
        return Err("empty hotkey".into());
    }

    // Single-modifier form is legal only for the catch-all fallback; the
    // caller peels that case off before we're invoked.
    let last = &tokens[tokens.len() - 1];
    let mods = &tokens[..tokens.len() - 1];

    let mut modifier_events: SmallVec<[SyntheticEvent; 4]> = SmallVec::new();
    for m in mods {
        match parse_modifier(m) {
            Some(md) => modifier_events.push(SyntheticEvent::ModifierDown(md)),
            None => {
                return Err(format!(
                    "unknown modifier '{m}' in hotkey {tokens:?}"
                ))
            }
        }
    }

    // If the "last" token is itself a modifier, treat the whole list as
    // "hold these modifiers" — no key. This is the transparent-fallback
    // shape (single modifier, e.g. `[cmd]`) but generalised.
    if let Some(m) = parse_modifier(last) {
        if mods.is_empty() {
            // e.g. `to_hotkey: [cmd]` — pure modifier press-and-release.
            return Ok(vec![
                SyntheticEvent::ModifierDown(m),
                SyntheticEvent::ModifierUp(m),
            ]);
        }
        return Err(format!(
            "hotkey {tokens:?} is all-modifiers; the last token must be a key"
        ));
    }

    // Normal path: mods..., key down, key up, mods... (reversed).
    let key = parse_named_key(last)
        .ok_or_else(|| format!("unknown key '{last}' in hotkey {tokens:?}"))?;

    let mut out: Vec<SyntheticEvent> = Vec::with_capacity(modifier_events.len() * 2 + 2);
    out.extend(modifier_events.iter().copied());
    out.push(SyntheticEvent::KeyDown(key));
    out.push(SyntheticEvent::KeyUp(key));
    for ev in modifier_events.iter().rev() {
        if let SyntheticEvent::ModifierDown(m) = ev {
            out.push(SyntheticEvent::ModifierUp(*m));
        }
    }
    Ok(out)
}

fn parse_modifier(s: &str) -> Option<Modifier> {
    match s.to_ascii_lowercase().as_str() {
        "ctrl" | "control" => Some(Modifier::Ctrl),
        "alt" | "option" | "opt" => Some(Modifier::Alt),
        "shift" => Some(Modifier::Shift),
        "cmd" | "command" | "meta" => Some(Modifier::Cmd),
        "win" | "super" => Some(Modifier::Win),
        _ => None,
    }
}

fn parse_named_key(s: &str) -> Option<NamedKey> {
    match s.to_ascii_lowercase().as_str() {
        "escape" | "esc" => Some(NamedKey::Escape),
        "space" => Some(NamedKey::Space),
        "tab" => Some(NamedKey::Tab),
        "return" | "enter" => Some(NamedKey::Return),
        "delete" | "backspace" => Some(NamedKey::Delete),
        "f1" => Some(NamedKey::F1),
        "f2" => Some(NamedKey::F2),
        "f3" => Some(NamedKey::F3),
        "f4" => Some(NamedKey::F4),
        "f5" => Some(NamedKey::F5),
        "f6" => Some(NamedKey::F6),
        "f7" => Some(NamedKey::F7),
        "f8" => Some(NamedKey::F8),
        "f9" => Some(NamedKey::F9),
        "f10" => Some(NamedKey::F10),
        "f11" => Some(NamedKey::F11),
        "f12" => Some(NamedKey::F12),
        other if other.len() == 1 => {
            let b = other.as_bytes()[0].to_ascii_uppercase();
            if b.is_ascii_uppercase() || b.is_ascii_digit() {
                Some(NamedKey::Alpha(b))
            } else {
                None
            }
        }
        _ => None,
    }
}

fn platform_matches(p: &str) -> bool {
    let p = p.to_ascii_lowercase();
    let p = p.as_str();
    #[cfg(target_os = "macos")]
    {
        matches!(p, "macos" | "mac" | "darwin")
    }
    #[cfg(target_os = "windows")]
    {
        matches!(p, "windows" | "win" | "win32")
    }
    #[cfg(not(any(target_os = "macos", target_os = "windows")))]
    {
        matches!(p, "linux")
    }
}

// ---------------------------------------------------------------------------
// Default rules (YAML template) — used as a fallback if the user hasn't
// authored a file yet. Kept minimal on purpose; the richer documented
// version lives in `rules-template.ts` on the TS side.

pub const DEFAULT_RULES_YAML: &str = r#"
capslock:
  to_hotkey:
    on_tap: escape
    on_hold: ctrl

space:
  to_hotkey:
    on_tap: space
    on_hold:
      - description: "transparent Cmd on macOS (Space+C = Cmd+C, etc.)"
        platform: macos
        keys: [_default]
        to_hotkey: [cmd]
"#;

// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;

    fn alpha(c: char) -> NamedKey {
        NamedKey::Alpha(c as u8)
    }

    #[test]
    fn parses_default_yaml() {
        let r = parse(DEFAULT_RULES_YAML).expect("default rules parse");
        assert!(r.capslock.is_some());
        assert!(r.space.is_some());
    }

    #[test]
    fn capslock_transparent_ctrl_with_escape_on_tap() {
        let src = r#"
capslock:
  to_hotkey:
    on_tap: escape
    on_hold: ctrl
"#;
        let r = parse(src).unwrap();
        let c = r.capslock.unwrap();
        assert_eq!(
            c.on_tap.as_deref(),
            Some(
                vec![
                    SyntheticEvent::KeyDown(NamedKey::Escape),
                    SyntheticEvent::KeyUp(NamedKey::Escape)
                ]
                .as_slice()
            )
        );
        match c.on_hold {
            ResolvedHold::TransparentModifier(Modifier::Ctrl) => {}
            other => panic!("expected TransparentModifier(Ctrl), got {other:?}"),
        }
    }

    #[test]
    fn space_explicit_overrides_with_fallback_modifier() {
        let src = r#"
space:
  to_hotkey:
    on_tap: space
    on_hold:
      - keys: [w]
        to_hotkey: [ctrl, alt, s]
      - keys: [_default]
        to_hotkey: [cmd]
"#;
        let r = parse(src).unwrap();
        let s = r.space.unwrap();
        match s.on_hold {
            ResolvedHold::Explicit { overrides, fallback } => {
                assert_eq!(fallback, Some(Modifier::Cmd));
                let events = overrides.get("W").expect("W override present");
                assert_eq!(
                    events.as_slice(),
                    &[
                        SyntheticEvent::ModifierDown(Modifier::Ctrl),
                        SyntheticEvent::ModifierDown(Modifier::Alt),
                        SyntheticEvent::KeyDown(alpha('S')),
                        SyntheticEvent::KeyUp(alpha('S')),
                        SyntheticEvent::ModifierUp(Modifier::Alt),
                        SyntheticEvent::ModifierUp(Modifier::Ctrl),
                    ]
                );
            }
            other => panic!("expected Explicit, got {other:?}"),
        }
    }

    #[test]
    fn uppercases_trigger_keys() {
        let src = r#"
space:
  to_hotkey:
    on_hold:
      - keys: [w]
        to_hotkey: [ctrl, alt, s]
"#;
        let r = parse(src).unwrap();
        match r.space.unwrap().on_hold {
            ResolvedHold::Explicit { overrides, .. } => {
                assert!(overrides.contains_key("W"));
            }
            _ => panic!(),
        }
    }

    #[test]
    fn platform_filter_drops_other_platform_rules() {
        let src = r#"
space:
  to_hotkey:
    on_hold:
      - keys: [q]
        platform: windows
        to_hotkey: [alt, f4]
      - keys: [w]
        platform: macos
        to_hotkey: [ctrl, alt, s]
"#;
        let r = parse(src).unwrap();
        match r.space.unwrap().on_hold {
            ResolvedHold::Explicit { overrides, .. } => {
                #[cfg(target_os = "macos")]
                {
                    assert!(overrides.contains_key("W"));
                    assert!(!overrides.contains_key("Q"));
                }
                #[cfg(target_os = "windows")]
                {
                    assert!(overrides.contains_key("Q"));
                    assert!(!overrides.contains_key("W"));
                }
                #[cfg(not(any(target_os = "macos", target_os = "windows")))]
                {
                    assert!(overrides.is_empty());
                }
            }
            _ => panic!(),
        }
    }

    #[test]
    fn on_tap_accepts_a_combo_list() {
        let src = r#"
capslock:
  to_hotkey:
    on_tap: [ctrl, c]
"#;
        let r = parse(src).unwrap();
        let c = r.capslock.unwrap();
        assert_eq!(
            c.on_tap.unwrap(),
            vec![
                SyntheticEvent::ModifierDown(Modifier::Ctrl),
                SyntheticEvent::KeyDown(alpha('C')),
                SyntheticEvent::KeyUp(alpha('C')),
                SyntheticEvent::ModifierUp(Modifier::Ctrl),
            ]
        );
    }

    #[test]
    fn omitting_trigger_leaves_it_disabled() {
        let src = r#"
capslock:
  to_hotkey:
    on_tap: escape
    on_hold: ctrl
"#;
        let r = parse(src).unwrap();
        assert!(r.space.is_none());
        assert!(r.capslock.is_some());
    }

    #[test]
    fn rejects_unknown_modifier() {
        let src = r#"
capslock:
  to_hotkey:
    on_hold: banana
"#;
        assert!(parse(src).is_err());
    }

    #[test]
    fn multi_key_triggers_are_skipped_not_errored() {
        let src = r#"
space:
  to_hotkey:
    on_hold:
      - keys: [ctrl, l]
        to_hotkey: [win, l]
      - keys: [w]
        to_hotkey: [ctrl, alt, s]
"#;
        let r = parse(src).unwrap();
        match r.space.unwrap().on_hold {
            ResolvedHold::Explicit { overrides, .. } => {
                assert!(overrides.contains_key("W"));
                // Multi-key rule got dropped, not errored out.
                assert_eq!(overrides.len(), 1);
            }
            _ => panic!(),
        }
    }
}
