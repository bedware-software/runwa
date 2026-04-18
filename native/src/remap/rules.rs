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
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
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
    // Navigation.
    Left,
    Right,
    Up,
    Down,
    Home,
    End,
    PageUp,
    PageDown,
    // Punctuation on a US ANSI layout. Stored by semantic name so the match
    // works regardless of shift state (e.g. `Backtick` covers both `` ` ``
    // and `~`; the synthesized output decides whether to press Shift).
    Backtick,
    Minus,
    Equals,
    LeftBracket,
    RightBracket,
    Backslash,
    Semicolon,
    Quote,
    Comma,
    Period,
    Slash,
    /// An uppercase ASCII alpha (A–Z) or digit (0–9). Stored as the ASCII
    /// byte so callers can match/synth uniformly.
    Alpha(u8),
}

/// A single side-effect the platform layer should perform. Keyboard
/// synthesis lives here, plus higher-level OS actions like switching
/// virtual desktops (Windows-only; no-op on other platforms).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum SyntheticEvent {
    ModifierDown(Modifier),
    ModifierUp(Modifier),
    KeyDown(NamedKey),
    KeyUp(NamedKey),
    /// Switch to virtual desktop `N` (1-indexed to match what the user
    /// writes in the YAML and what their old AHK setup used).
    SwitchToWorkspace(u32),
    /// Move the active window to virtual desktop `N` and follow it there.
    MoveToWorkspace(u32),
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
    /// Explicit per-combo overrides keyed by the trigger `NamedKey`. The
    /// state machine resolves the incoming event to a `NamedKey` and does
    /// a direct lookup — no token-string shuffle.
    Explicit {
        overrides: HashMap<NamedKey, Vec<SyntheticEvent>>,
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
    on_tap: Option<serde_yml::Value>,
    #[serde(default)]
    on_hold: Option<serde_yml::Value>,
}

/// Parsed form of `on_tap:` — either a single key name or a combo list.
enum TapSpec {
    Single(String),
    Combo(Vec<String>),
}

/// Parsed form of `on_hold:` — either a scalar modifier name (transparent
/// layer) or an explicit rules list.
enum HoldSpec {
    Transparent(String),
    Rules(Vec<HoldRule>),
}

fn parse_tap_spec(v: &serde_yml::Value) -> Result<TapSpec, String> {
    if let Some(s) = v.as_str() {
        return Ok(TapSpec::Single(s.to_string()));
    }
    if let Some(seq) = v.as_sequence() {
        let tokens = seq
            .iter()
            .map(|it| {
                it.as_str()
                    .map(|s| s.to_string())
                    .ok_or_else(|| format!("on_tap list item must be a string, got {it:?}"))
            })
            .collect::<Result<Vec<_>, _>>()?;
        return Ok(TapSpec::Combo(tokens));
    }
    Err(format!(
        "on_tap must be a string or a list of strings, got {v:?}"
    ))
}

fn parse_hold_spec(v: &serde_yml::Value) -> Result<HoldSpec, String> {
    if let Some(s) = v.as_str() {
        return Ok(HoldSpec::Transparent(s.to_string()));
    }
    if v.is_sequence() {
        let rules: Vec<HoldRule> = serde_yml::from_value(v.clone())
            .map_err(|e| format!("on_hold rules list: {e}"))?;
        return Ok(HoldSpec::Rules(rules));
    }
    Err(format!(
        "on_hold must be a scalar modifier name or a list of rules, got {v:?}"
    ))
}

/// A single rule inside an `on_hold:` list. Exactly one of the action
/// fields (`to_hotkey` / `switch_to_workspace` / `move_to_workspace`)
/// must be populated; having zero or multiple is a parse error.
///
/// `keys` and `to_hotkey` are `Vec<YamlToken>` so YAML can supply either
/// a string (`keys: [w]`, `keys: [","]`) or an integer (`keys: [1]`) —
/// both become strings internally.
#[derive(Debug, Deserialize)]
struct HoldRule {
    #[serde(default)]
    description: Option<String>,
    #[serde(default)]
    platform: Option<String>,
    keys: Vec<YamlToken>,
    // Actions — exactly one per rule.
    #[serde(default)]
    to_hotkey: Option<Vec<YamlToken>>,
    #[serde(default)]
    switch_to_workspace: Option<u32>,
    #[serde(default)]
    move_to_workspace: Option<u32>,
}

/// Accepts a YAML scalar that might be a string or a number; normalizes
/// to a String. Lets users write `keys: [1]` without quoting.
#[derive(Debug, Clone)]
struct YamlToken(String);

impl YamlToken {
    fn as_str(&self) -> &str {
        &self.0
    }
}

impl<'de> Deserialize<'de> for YamlToken {
    fn deserialize<D>(d: D) -> Result<Self, D::Error>
    where
        D: serde::Deserializer<'de>,
    {
        struct V;
        impl<'de> serde::de::Visitor<'de> for V {
            type Value = YamlToken;
            fn expecting(&self, f: &mut std::fmt::Formatter) -> std::fmt::Result {
                f.write_str("a string or a number")
            }
            fn visit_str<E: serde::de::Error>(self, s: &str) -> Result<YamlToken, E> {
                Ok(YamlToken(s.to_string()))
            }
            fn visit_string<E: serde::de::Error>(self, s: String) -> Result<YamlToken, E> {
                Ok(YamlToken(s))
            }
            fn visit_i64<E: serde::de::Error>(self, n: i64) -> Result<YamlToken, E> {
                Ok(YamlToken(n.to_string()))
            }
            fn visit_u64<E: serde::de::Error>(self, n: u64) -> Result<YamlToken, E> {
                Ok(YamlToken(n.to_string()))
            }
            fn visit_f64<E: serde::de::Error>(self, n: f64) -> Result<YamlToken, E> {
                Ok(YamlToken(n.to_string()))
            }
        }
        d.deserialize_any(V)
    }
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
        None => None,
        Some(v) => match parse_tap_spec(v)? {
            TapSpec::Single(s) => Some(bake_hotkey_tokens(std::slice::from_ref(&s))?),
            TapSpec::Combo(items) => Some(bake_hotkey_tokens(items.as_slice())?),
        },
    };

    let on_hold = match &remap.to_hotkey.on_hold {
        None => ResolvedHold::Passthrough,
        Some(v) => match parse_hold_spec(v)? {
            HoldSpec::Transparent(name) => match parse_modifier(&name) {
                Some(m) => ResolvedHold::TransparentModifier(m),
                None => {
                    return Err(format!(
                        "on_hold '{name}' is not a recognised modifier name"
                    ))
                }
            },
            HoldSpec::Rules(list) => {
            let mut overrides: HashMap<NamedKey, Vec<SyntheticEvent>> = HashMap::new();
            let mut fallback: Option<Modifier> = None;

            for rule in &list {
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

                let trigger_raw = rule.keys[0].as_str();

                if trigger_raw.eq_ignore_ascii_case("_default") {
                    // _default only makes sense with to_hotkey = single modifier.
                    let to = rule.to_hotkey.as_deref().ok_or_else(|| {
                        "rule with keys: [_default] must use `to_hotkey: [<modifier>]`".to_string()
                    })?;
                    if to.len() != 1 {
                        return Err(format!(
                            "rule with keys: [_default] must have to_hotkey = a single modifier, got {to:?}"
                        ));
                    }
                    match parse_modifier(to[0].as_str()) {
                        Some(m) => fallback = Some(m),
                        None => {
                            return Err(format!(
                                "rule with keys: [_default] has unknown modifier '{}'",
                                to[0].as_str()
                            ))
                        }
                    }
                    continue;
                }

                let trigger_key = parse_named_key(trigger_raw).ok_or_else(|| {
                    format!("unknown trigger key '{trigger_raw}' in rule")
                })?;

                let events = bake_rule_action(rule)?;
                overrides.insert(trigger_key, events);
            }

                ResolvedHold::Explicit { overrides, fallback }
            }
        },
    };

    Ok(ResolvedBinding { on_tap, on_hold })
}

/// Pick the action out of a HoldRule and bake it to a synthetic event
/// sequence. Exactly one of `to_hotkey` / `switch_to_workspace` /
/// `move_to_workspace` must be populated.
fn bake_rule_action(rule: &HoldRule) -> Result<Vec<SyntheticEvent>, String> {
    let mut provided: SmallVec<[&'static str; 3]> = SmallVec::new();
    if rule.to_hotkey.is_some() {
        provided.push("to_hotkey");
    }
    if rule.switch_to_workspace.is_some() {
        provided.push("switch_to_workspace");
    }
    if rule.move_to_workspace.is_some() {
        provided.push("move_to_workspace");
    }
    let name = rule.description.as_deref().unwrap_or("<unnamed>");
    match provided.as_slice() {
        [] => Err(format!(
            "rule '{name}' needs exactly one of: to_hotkey, switch_to_workspace, move_to_workspace"
        )),
        [_, ..] if provided.len() > 1 => Err(format!(
            "rule '{name}' has multiple action fields {provided:?}; pick exactly one"
        )),
        ["to_hotkey"] => {
            let tokens: Vec<String> = rule
                .to_hotkey
                .as_ref()
                .unwrap()
                .iter()
                .map(|t| t.0.clone())
                .collect();
            bake_hotkey_tokens(&tokens)
        }
        ["switch_to_workspace"] => {
            let n = rule.switch_to_workspace.unwrap();
            if n == 0 {
                return Err(format!("rule '{name}': switch_to_workspace must be >= 1"));
            }
            Ok(vec![SyntheticEvent::SwitchToWorkspace(n)])
        }
        ["move_to_workspace"] => {
            let n = rule.move_to_workspace.unwrap();
            if n == 0 {
                return Err(format!("rule '{name}': move_to_workspace must be >= 1"));
            }
            Ok(vec![SyntheticEvent::MoveToWorkspace(n)])
        }
        _ => unreachable!(),
    }
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
        // Navigation — word forms only (arrows aren't typable as a single
        // character in YAML).
        "left" => Some(NamedKey::Left),
        "right" => Some(NamedKey::Right),
        "up" => Some(NamedKey::Up),
        "down" => Some(NamedKey::Down),
        "home" => Some(NamedKey::Home),
        "end" => Some(NamedKey::End),
        "pageup" | "pgup" => Some(NamedKey::PageUp),
        "pagedown" | "pgdn" | "pgdown" => Some(NamedKey::PageDown),
        // Punctuation — word aliases. Literal characters are handled in the
        // single-char arm below so users can write e.g. `keys: ["`"]`.
        "backtick" | "grave" => Some(NamedKey::Backtick),
        "minus" | "dash" | "hyphen" => Some(NamedKey::Minus),
        "equals" | "equal" => Some(NamedKey::Equals),
        "lbracket" | "leftbracket" | "openbracket" => Some(NamedKey::LeftBracket),
        "rbracket" | "rightbracket" | "closebracket" => Some(NamedKey::RightBracket),
        "backslash" => Some(NamedKey::Backslash),
        "semicolon" => Some(NamedKey::Semicolon),
        "quote" | "apostrophe" => Some(NamedKey::Quote),
        "comma" => Some(NamedKey::Comma),
        "period" | "dot" => Some(NamedKey::Period),
        "slash" | "forwardslash" => Some(NamedKey::Slash),
        other if other.len() == 1 => parse_single_char(other.as_bytes()[0]),
        _ => None,
    }
}

fn parse_single_char(b: u8) -> Option<NamedKey> {
    // Letters/digits first — these preserve the Alpha(byte) shape for
    // cheap matching.
    let up = b.to_ascii_uppercase();
    if up.is_ascii_uppercase() || up.is_ascii_digit() {
        return Some(NamedKey::Alpha(up));
    }
    // Punctuation literals on a US layout. Both the unshifted and shifted
    // forms map to the same NamedKey (the shift state of the injected event
    // is what decides which glyph comes out).
    match b {
        b'`' | b'~' => Some(NamedKey::Backtick),
        b'-' | b'_' => Some(NamedKey::Minus),
        b'=' | b'+' => Some(NamedKey::Equals),
        b'[' | b'{' => Some(NamedKey::LeftBracket),
        b']' | b'}' => Some(NamedKey::RightBracket),
        b'\\' | b'|' => Some(NamedKey::Backslash),
        b';' | b':' => Some(NamedKey::Semicolon),
        b'\'' | b'"' => Some(NamedKey::Quote),
        b',' | b'<' => Some(NamedKey::Comma),
        b'.' | b'>' => Some(NamedKey::Period),
        b'/' | b'?' => Some(NamedKey::Slash),
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

#[allow(dead_code)]
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
                let events = overrides.get(&alpha('W')).expect("W override present");
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
                assert!(overrides.contains_key(&alpha('W')));
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
                    assert!(overrides.contains_key(&alpha('W')));
                    assert!(!overrides.contains_key(&alpha('Q')));
                }
                #[cfg(target_os = "windows")]
                {
                    assert!(overrides.contains_key(&alpha('Q')));
                    assert!(!overrides.contains_key(&alpha('W')));
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
    fn punctuation_trigger_keys_parse() {
        let src = r#"
space:
  to_hotkey:
    on_hold:
      - keys: [","]
        to_hotkey: [home]
      - keys: ["`"]
        to_hotkey: [win, "`"]
      - keys: [.]
        to_hotkey: [end]
"#;
        let r = parse(src).unwrap();
        match r.space.unwrap().on_hold {
            ResolvedHold::Explicit { overrides, .. } => {
                assert!(overrides.contains_key(&NamedKey::Comma));
                assert!(overrides.contains_key(&NamedKey::Backtick));
                assert!(overrides.contains_key(&NamedKey::Period));
                // Win+` output has Win-down, `-down, `-up, Win-up.
                let events = overrides.get(&NamedKey::Backtick).unwrap();
                assert_eq!(
                    events.as_slice(),
                    &[
                        SyntheticEvent::ModifierDown(Modifier::Win),
                        SyntheticEvent::KeyDown(NamedKey::Backtick),
                        SyntheticEvent::KeyUp(NamedKey::Backtick),
                        SyntheticEvent::ModifierUp(Modifier::Win),
                    ]
                );
            }
            _ => panic!(),
        }
    }

    #[test]
    fn arrow_key_triggers_parse() {
        let src = r#"
space:
  to_hotkey:
    on_hold:
      - keys: [j]
        to_hotkey: [down]
      - keys: [k]
        to_hotkey: [up]
"#;
        let r = parse(src).unwrap();
        match r.space.unwrap().on_hold {
            ResolvedHold::Explicit { overrides, .. } => {
                let down = overrides.get(&alpha('J')).unwrap();
                assert_eq!(
                    down.as_slice(),
                    &[
                        SyntheticEvent::KeyDown(NamedKey::Down),
                        SyntheticEvent::KeyUp(NamedKey::Down),
                    ]
                );
                let up = overrides.get(&alpha('K')).unwrap();
                assert_eq!(
                    up.as_slice(),
                    &[
                        SyntheticEvent::KeyDown(NamedKey::Up),
                        SyntheticEvent::KeyUp(NamedKey::Up),
                    ]
                );
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
    fn switch_to_workspace_action_parses() {
        let src = r#"
space:
  to_hotkey:
    on_tap: space
    on_hold:
      - keys: [1]
        switch_to_workspace: 1
      - keys: [2]
        move_to_workspace: 2
"#;
        let r = parse(src).expect("parse");
        match r.space.unwrap().on_hold {
            ResolvedHold::Explicit { overrides, .. } => {
                assert_eq!(
                    overrides.get(&alpha('1')).unwrap().as_slice(),
                    &[SyntheticEvent::SwitchToWorkspace(1)]
                );
                assert_eq!(
                    overrides.get(&alpha('2')).unwrap().as_slice(),
                    &[SyntheticEvent::MoveToWorkspace(2)]
                );
            }
            _ => panic!(),
        }
    }

    #[test]
    fn rule_without_action_errors() {
        let src = r#"
space:
  to_hotkey:
    on_hold:
      - keys: [1]
"#;
        let err = parse(src).unwrap_err();
        assert!(
            err.contains("exactly one of"),
            "expected action-missing error, got: {err}"
        );
    }

    #[test]
    fn rule_with_multiple_actions_errors() {
        let src = r#"
space:
  to_hotkey:
    on_hold:
      - keys: [1]
        to_hotkey: [left]
        switch_to_workspace: 1
"#;
        let err = parse(src).unwrap_err();
        assert!(
            err.contains("multiple action fields"),
            "expected multiple-actions error, got: {err}"
        );
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
                assert!(overrides.contains_key(&alpha('W')));
                // Multi-key rule got dropped, not errored out.
                assert_eq!(overrides.len(), 1);
            }
            _ => panic!(),
        }
    }
}
