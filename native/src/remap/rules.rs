//! Rule schema v3.
//!
//! YAML config is a map keyed by the trigger key name — any recognised
//! logical key works (`capslock`, `space`, `shift`, `ctrl`, `alt`, `cmd`,
//! alpha keys, F-keys, punctuation, …). Each entry is a dual-role remap:
//! what happens on tap (press-release alone) vs on hold (press-and-
//! interrupt-with-another-key). Presence of a trigger block is what
//! enables it; omit it and the key behaves normally.
//!
//! ```yaml
//! capslock:
//!   on_tap: [escape]
//!   on_hold: [ctrl]
//!
//! shift:
//!   on_tap: [cmd, space]       # tap-alone emits Cmd+Space (Spotlight)
//!                              # on_hold defaults to transparent Shift
//!                              # because the trigger itself is a modifier
//!
//! space:
//!   on_tap: [space]
//!   on_hold:
//!     - { keys: [w], to_hotkey: [ctrl, alt, s] }
//!     - description: transparent Cmd for unmapped combos (macOS only)
//!       os: macos
//!       keys: [_default]
//!       to_hotkey: [cmd]
//! ```
//!
//! `on_tap` and `on_hold` accept either a scalar or a list for backwards
//! compatibility (`on_tap: escape` and `on_tap: [escape]` both work). A
//! list of strings with a single modifier — `on_hold: [ctrl]` — is
//! treated as a transparent modifier layer; a list of rule maps is the
//! full per-combo override form.

use serde::Deserialize;
use smallvec::SmallVec;
use std::collections::HashMap;

use super::state::LogicalKey;

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

/// Bitmask of physically-held modifiers at the moment of a non-modifier
/// key press. Used to disambiguate `keys: [1]` from `keys: [shift, 1]` in
/// explicit-override rules.
///
/// `Cmd` and `Win` share a bit since the state machine treats them as the
/// same logical modifier (Cmd on macOS, Win on Windows).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Default)]
pub struct ModifierMask(u8);

impl ModifierMask {
    pub const EMPTY: Self = Self(0);

    const CTRL_BIT: u8 = 1 << 0;
    const ALT_BIT: u8 = 1 << 1;
    const SHIFT_BIT: u8 = 1 << 2;
    const CMD_BIT: u8 = 1 << 3;

    pub fn insert(&mut self, m: Modifier) {
        self.0 |= Self::bit(m);
    }

    pub fn is_empty(self) -> bool {
        self.0 == 0
    }

    fn bit(m: Modifier) -> u8 {
        match m {
            Modifier::Ctrl => Self::CTRL_BIT,
            Modifier::Alt => Self::ALT_BIT,
            Modifier::Shift => Self::SHIFT_BIT,
            Modifier::Cmd | Modifier::Win => Self::CMD_BIT,
        }
    }
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
    /// Per-trigger bindings keyed by the logical key the trigger corresponds
    /// to. The state machine does `triggers.get(&incoming_key)` to decide
    /// whether a key should enter Pending.
    pub triggers: HashMap<LogicalKey, ResolvedBinding>,
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
    /// Explicit per-combo overrides keyed by (required physical modifiers,
    /// trigger `NamedKey`). The state machine resolves the incoming event
    /// to `(mods, NamedKey)` and first tries the exact-modifier lookup; if
    /// that misses it falls back to the `(EMPTY, key)` form so existing
    /// unqualified rules like `keys: [w]` still fire under a Shift-held
    /// press (the fallback-modifier path stamps the physical modifier on
    /// the synthesized output).
    Explicit {
        overrides: HashMap<(ModifierMask, NamedKey), Vec<SyntheticEvent>>,
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
//
// The config is a map keyed by the trigger key name (any recognised logical
// key). `on_tap` and `on_hold` live directly on the entry — no `to_hotkey:`
// wrapper. Unknown keys at the top level are trigger names, so we can't
// use `deny_unknown_fields`; the resolver validates each key by trying to
// parse it via `parse_trigger_key`.

type Config = HashMap<String, KeyRemap>;

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
struct KeyRemap {
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
    if let Some(seq) = v.as_sequence() {
        // Two list shapes share one YAML type:
        //   on_hold: [ctrl]                         → transparent modifier list
        //   on_hold:                                → rules list
        //     - { keys: [...], to_hotkey: [...] }
        // Peek at the first element to disambiguate: all-strings is the
        // modifier form, maps-in-the-list is the rules form.
        if seq.iter().all(|e| e.is_string()) {
            let names: Vec<&str> = seq.iter().map(|e| e.as_str().unwrap()).collect();
            match names.as_slice() {
                [] => {
                    return Err(
                        "on_hold list is empty — omit `on_hold` entirely to disable the hold layer"
                            .into(),
                    )
                }
                [only] => return Ok(HoldSpec::Transparent((*only).to_string())),
                _ => {
                    return Err(format!(
                        "on_hold modifier list must have exactly one entry; \
                         multi-modifier transparent layers aren't supported yet: {names:?}"
                    ))
                }
            }
        }
        let rules: Vec<HoldRule> = serde_yml::from_value(v.clone())
            .map_err(|e| format!("on_hold rules list: {e}"))?;
        return Ok(HoldSpec::Rules(rules));
    }
    Err(format!(
        "on_hold must be a scalar modifier name, a single-modifier list like [ctrl], \
         or a list of rule objects, got {v:?}"
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
    os: Option<String>,
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
    // An empty file deserialises to `Null`, which serde can't turn into a
    // map — accept it explicitly as "no triggers".
    let trimmed = yaml.trim();
    if trimmed.is_empty() {
        return Ok(ResolvedRules::default());
    }
    let cfg: Config = serde_yml::from_str(yaml).map_err(|e| format!("{e}"))?;
    let mut triggers: HashMap<LogicalKey, ResolvedBinding> = HashMap::new();
    for (name, remap) in &cfg {
        let key = parse_trigger_key(name).ok_or_else(|| {
            format!(
                "unknown trigger key '{name}' at top level — expected a logical key name like \
                 capslock, space, shift, ctrl, alt, cmd, a letter, a named key (escape/tab/…), \
                 or a punctuation alias"
            )
        })?;
        let binding = resolve_binding(key, remap)?;
        triggers.insert(key, binding);
    }
    Ok(ResolvedRules { triggers })
}

fn resolve_binding(trigger: LogicalKey, remap: &KeyRemap) -> Result<ResolvedBinding, String> {
    let on_tap = match &remap.on_tap {
        None => None,
        Some(v) => match parse_tap_spec(v)? {
            TapSpec::Single(s) => Some(bake_hotkey_tokens(std::slice::from_ref(&s))?),
            TapSpec::Combo(items) => Some(bake_hotkey_tokens(items.as_slice())?),
        },
    };

    let on_hold = match &remap.on_hold {
        None => default_on_hold(trigger),
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
            let mut overrides: HashMap<(ModifierMask, NamedKey), Vec<SyntheticEvent>> =
                HashMap::new();
            let mut fallback: Option<Modifier> = None;

            for rule in &list {
                // OS gate.
                if let Some(p) = &rule.os {
                    if !os_matches(p) {
                        continue;
                    }
                }

                if rule.keys.is_empty() {
                    return Err(format!(
                        "rule '{}': keys list cannot be empty",
                        rule.description.as_deref().unwrap_or("<unnamed>"),
                    ));
                }

                // Last element of keys is the trigger key; any preceding
                // elements are required physical modifiers. So
                // `keys: [w]`         → mods = {}, trigger = W
                // `keys: [shift, w]`  → mods = {Shift}, trigger = W
                // `keys: [ctrl, shift, 1]` → mods = {Ctrl,Shift}, trigger = 1
                let (mods_tokens, trigger_token) = rule.keys.split_at(rule.keys.len() - 1);
                let trigger_raw = trigger_token[0].as_str();

                if trigger_raw.eq_ignore_ascii_case("_default") {
                    if !mods_tokens.is_empty() {
                        return Err(format!(
                            "rule '{}': [_default] cannot be prefixed with modifiers",
                            rule.description.as_deref().unwrap_or("<unnamed>"),
                        ));
                    }
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

                let mut mods = ModifierMask::EMPTY;
                for t in mods_tokens {
                    match parse_modifier(t.as_str()) {
                        Some(m) => mods.insert(m),
                        None => {
                            return Err(format!(
                                "rule '{}': unknown modifier '{}' in keys prefix — \
                                 expected ctrl/alt/shift/cmd/win (or aliases)",
                                rule.description.as_deref().unwrap_or("<unnamed>"),
                                t.as_str(),
                            ))
                        }
                    }
                }

                let trigger_key = parse_named_key(trigger_raw).ok_or_else(|| {
                    format!("unknown trigger key '{trigger_raw}' in rule")
                })?;

                let events = bake_rule_action(rule)?;
                overrides.insert((mods, trigger_key), events);
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

/// Resolve a top-level trigger name (as written in the YAML) to the
/// `LogicalKey` the state machine matches on. Accepts modifier names
/// (`shift`, `ctrl`, …) plus everything `parse_named_key` understands,
/// plus the non-Named triggers `capslock` and `space`.
fn parse_trigger_key(name: &str) -> Option<LogicalKey> {
    let lower = name.to_ascii_lowercase();
    match lower.as_str() {
        "capslock" | "caps_lock" | "caps-lock" => Some(LogicalKey::CapsLock),
        "space" => Some(LogicalKey::Space),
        "shift" => Some(LogicalKey::Shift),
        "ctrl" | "control" => Some(LogicalKey::Ctrl),
        "alt" | "option" | "opt" => Some(LogicalKey::Alt),
        "cmd" | "command" | "meta" | "win" | "super" => Some(LogicalKey::Cmd),
        _ => parse_named_key(&lower).map(LogicalKey::Named),
    }
}

/// Sensible `on_hold` default when the user didn't write one. For a
/// modifier trigger (Shift/Ctrl/Alt/Cmd) we default to a transparent
/// layer of that same modifier — otherwise a `shift: { on_tap: [cmd,
/// space] }` rule would swallow the user's real Shift usage (Shift+L
/// would arrive as lowercase l because we'd suppress Shift-down waiting
/// for tap-vs-hold). For non-modifier triggers (CapsLock, Space, …)
/// Passthrough is correct — the trigger is consumed and the interrupting
/// key goes through naked.
fn default_on_hold(trigger: LogicalKey) -> ResolvedHold {
    match trigger {
        LogicalKey::Shift => ResolvedHold::TransparentModifier(Modifier::Shift),
        LogicalKey::Ctrl => ResolvedHold::TransparentModifier(Modifier::Ctrl),
        LogicalKey::Alt => ResolvedHold::TransparentModifier(Modifier::Alt),
        LogicalKey::Cmd => ResolvedHold::TransparentModifier(Modifier::Cmd),
        _ => ResolvedHold::Passthrough,
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

fn os_matches(p: &str) -> bool {
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
  on_tap: [escape]
  on_hold: [ctrl]

space:
  on_tap: [space]
  on_hold:
    - description: "transparent Cmd on macOS (Space+C = Cmd+C, etc.)"
      os: macos
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

    /// Shorthand for the `(ModifierMask, NamedKey)` map key the override
    /// table uses. Covers the common case of unqualified rules.
    fn ov(nk: NamedKey) -> (ModifierMask, NamedKey) {
        (ModifierMask::EMPTY, nk)
    }

    fn binding<'a>(r: &'a ResolvedRules, key: LogicalKey) -> &'a ResolvedBinding {
        r.triggers.get(&key).expect("binding present")
    }

    #[test]
    fn parses_default_yaml() {
        let r = parse(DEFAULT_RULES_YAML).expect("default rules parse");
        assert!(r.triggers.contains_key(&LogicalKey::CapsLock));
        assert!(r.triggers.contains_key(&LogicalKey::Space));
    }

    #[test]
    fn capslock_transparent_ctrl_with_escape_on_tap() {
        let src = r#"
capslock:
  on_tap: [escape]
  on_hold: [ctrl]
"#;
        let r = parse(src).unwrap();
        let c = binding(&r, LogicalKey::CapsLock);
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
        match &c.on_hold {
            ResolvedHold::TransparentModifier(Modifier::Ctrl) => {}
            other => panic!("expected TransparentModifier(Ctrl), got {other:?}"),
        }
    }

    #[test]
    fn space_explicit_overrides_with_fallback_modifier() {
        let src = r#"
space:
  on_tap: [space]
  on_hold:
    - keys: [w]
      to_hotkey: [ctrl, alt, s]
    - keys: [_default]
      to_hotkey: [cmd]
"#;
        let r = parse(src).unwrap();
        let s = binding(&r, LogicalKey::Space);
        match &s.on_hold {
            ResolvedHold::Explicit { overrides, fallback } => {
                assert_eq!(*fallback, Some(Modifier::Cmd));
                let events = overrides.get(&ov(alpha('W'))).expect("W override present");
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
  on_hold:
    - keys: [w]
      to_hotkey: [ctrl, alt, s]
"#;
        let r = parse(src).unwrap();
        match &binding(&r, LogicalKey::Space).on_hold {
            ResolvedHold::Explicit { overrides, .. } => {
                assert!(overrides.contains_key(&ov(alpha('W'))));
            }
            _ => panic!(),
        }
    }

    #[test]
    fn os_filter_drops_other_os_rules() {
        let src = r#"
space:
  on_hold:
    - keys: [q]
      os: windows
      to_hotkey: [alt, f4]
    - keys: [w]
      os: macos
      to_hotkey: [ctrl, alt, s]
"#;
        let r = parse(src).unwrap();
        match &binding(&r, LogicalKey::Space).on_hold {
            ResolvedHold::Explicit { overrides, .. } => {
                #[cfg(target_os = "macos")]
                {
                    assert!(overrides.contains_key(&ov(alpha('W'))));
                    assert!(!overrides.contains_key(&ov(alpha('Q'))));
                }
                #[cfg(target_os = "windows")]
                {
                    assert!(overrides.contains_key(&ov(alpha('Q'))));
                    assert!(!overrides.contains_key(&ov(alpha('W'))));
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
  on_hold:
    - keys: [","]
      to_hotkey: [home]
    - keys: ["`"]
      to_hotkey: [win, "`"]
    - keys: [.]
      to_hotkey: [end]
"#;
        let r = parse(src).unwrap();
        match &binding(&r, LogicalKey::Space).on_hold {
            ResolvedHold::Explicit { overrides, .. } => {
                assert!(overrides.contains_key(&ov(NamedKey::Comma)));
                assert!(overrides.contains_key(&ov(NamedKey::Backtick)));
                assert!(overrides.contains_key(&ov(NamedKey::Period)));
                // Win+` output has Win-down, `-down, `-up, Win-up.
                let events = overrides.get(&ov(NamedKey::Backtick)).unwrap();
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
  on_hold:
    - keys: [j]
      to_hotkey: [down]
    - keys: [k]
      to_hotkey: [up]
"#;
        let r = parse(src).unwrap();
        match &binding(&r, LogicalKey::Space).on_hold {
            ResolvedHold::Explicit { overrides, .. } => {
                let down = overrides.get(&ov(alpha('J'))).unwrap();
                assert_eq!(
                    down.as_slice(),
                    &[
                        SyntheticEvent::KeyDown(NamedKey::Down),
                        SyntheticEvent::KeyUp(NamedKey::Down),
                    ]
                );
                let up = overrides.get(&ov(alpha('K'))).unwrap();
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
  on_tap: [ctrl, c]
"#;
        let r = parse(src).unwrap();
        let c = binding(&r, LogicalKey::CapsLock);
        assert_eq!(
            c.on_tap.clone().unwrap(),
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
  on_tap: [escape]
  on_hold: [ctrl]
"#;
        let r = parse(src).unwrap();
        assert!(!r.triggers.contains_key(&LogicalKey::Space));
        assert!(r.triggers.contains_key(&LogicalKey::CapsLock));
    }

    #[test]
    fn rejects_unknown_modifier() {
        let src = r#"
capslock:
  on_hold: banana
"#;
        assert!(parse(src).is_err());
    }

    #[test]
    fn switch_to_workspace_action_parses() {
        let src = r#"
space:
  on_tap: [space]
  on_hold:
    - keys: [1]
      switch_to_workspace: 1
    - keys: [2]
      move_to_workspace: 2
"#;
        let r = parse(src).expect("parse");
        match &binding(&r, LogicalKey::Space).on_hold {
            ResolvedHold::Explicit { overrides, .. } => {
                assert_eq!(
                    overrides.get(&ov(alpha('1'))).unwrap().as_slice(),
                    &[SyntheticEvent::SwitchToWorkspace(1)]
                );
                assert_eq!(
                    overrides.get(&ov(alpha('2'))).unwrap().as_slice(),
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
    fn modifier_prefixed_and_bare_triggers_coexist() {
        // Prefixed triggers (`keys: [ctrl, l]`) and bare triggers (`keys: [w]`)
        // should both parse and be keyed separately so modifier-qualified
        // rules don't clobber their bare counterparts.
        let src = r#"
space:
  on_hold:
    - keys: [ctrl, l]
      to_hotkey: [win, l]
    - keys: [w]
      to_hotkey: [ctrl, alt, s]
"#;
        let r = parse(src).unwrap();
        match &binding(&r, LogicalKey::Space).on_hold {
            ResolvedHold::Explicit { overrides, .. } => {
                let mut ctrl_mask = ModifierMask::EMPTY;
                ctrl_mask.insert(Modifier::Ctrl);
                assert!(overrides.contains_key(&(ctrl_mask, alpha('L'))));
                assert!(overrides.contains_key(&ov(alpha('W'))));
                assert_eq!(overrides.len(), 2);
            }
            _ => panic!(),
        }
    }

    #[test]
    fn shift_as_trigger_with_cmd_space_on_tap() {
        let src = r#"
shift:
  on_tap: [cmd, space]
"#;
        let r = parse(src).unwrap();
        let s = binding(&r, LogicalKey::Shift);
        // No on_hold written — modifier triggers default to transparent
        // layer of themselves so Shift+L still capitalises.
        match &s.on_hold {
            ResolvedHold::TransparentModifier(Modifier::Shift) => {}
            other => panic!("expected TransparentModifier(Shift), got {other:?}"),
        }
        assert_eq!(
            s.on_tap.clone().unwrap(),
            vec![
                SyntheticEvent::ModifierDown(Modifier::Cmd),
                SyntheticEvent::KeyDown(NamedKey::Space),
                SyntheticEvent::KeyUp(NamedKey::Space),
                SyntheticEvent::ModifierUp(Modifier::Cmd),
            ]
        );
    }

    #[test]
    fn unknown_top_level_key_errors() {
        let src = r#"
bananafish:
  on_tap: [escape]
"#;
        let err = parse(src).unwrap_err();
        assert!(
            err.contains("unknown trigger key"),
            "expected unknown-trigger error, got: {err}"
        );
    }

    // The full default template as shipped in rules-template.ts — guard
    // against a regression where tweaking the grammar in rules.rs breaks
    // the YAML the user sees on first launch.
    #[test]
    fn default_shipped_template_parses() {
        let src = r#"
capslock:
  on_tap: [escape]
  on_hold: [ctrl]

shift:
  on_tap: [cmd, space]

space:
  on_tap: [space]
  on_hold:
    - { keys: [w], to_hotkey: [ctrl, alt, s] }

    - { keys: [h], to_hotkey: [left] }
    - { keys: [j], to_hotkey: [down] }
    - { keys: [k], to_hotkey: [up] }
    - { keys: [l], to_hotkey: [right] }

    - { keys: [","], to_hotkey: [home] }
    - { keys: [.],   to_hotkey: [end] }
    - { keys: [u],   to_hotkey: [pageup] }
    - { keys: [p],   to_hotkey: [pagedown] }

    - { os: windows, keys: [q], to_hotkey: [alt, f4] }
    - { os: windows, keys: ["`"], to_hotkey: [win, "`"] }

    - { keys: [1], switch_to_workspace: 1 }
    - { keys: [2], switch_to_workspace: 2 }
    - { keys: [3], switch_to_workspace: 3 }

    - { os: macos, keys: [_default], to_hotkey: [cmd] }
"#;
        let r = parse(src).expect("default template must parse");
        assert!(r.triggers.contains_key(&LogicalKey::CapsLock));
        assert!(r.triggers.contains_key(&LogicalKey::Shift));
        assert!(r.triggers.contains_key(&LogicalKey::Space));
        // Shift with only on_tap written — hold defaults to transparent Shift.
        match &binding(&r, LogicalKey::Shift).on_hold {
            ResolvedHold::TransparentModifier(Modifier::Shift) => {}
            other => panic!("shift default on_hold should be TransparentModifier(Shift), got {other:?}"),
        }
    }
}
