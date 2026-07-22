//! Rule schema v3.
//!
//! YAML config is a map keyed by the trigger key name — any recognised
//! logical key works (`capslock`, `space`, `shift`, `right_shift`, `ctrl`,
//! `left_alt`, `cmd`, alpha keys, F-keys, punctuation, …). Each entry is a
//! dual-role remap:
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
//! right_shift:
//!   on_tap: [escape]           # only the physical right Shift
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

/// Platform-agnostic modifier. Unsided variants (`Shift`, `Ctrl`, ...)
/// preserve the historical behavior: they mean "either physical side" for
/// matching, and synthesize the left-side key when emitted. Sided variants
/// give configs precise control over left/right modifier keys.
///
/// `Cmd`/`Win` are treated as the same logical modifier at match time (Cmd on
/// macOS, Win on Windows), but both spellings are kept for readable synthetic
/// events and backwards-compatible tests.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub enum Modifier {
    Ctrl,
    LeftCtrl,
    RightCtrl,
    Alt,
    LeftAlt,
    RightAlt,
    Shift,
    LeftShift,
    RightShift,
    Cmd,
    LeftCmd,
    RightCmd,
    Win,
    LeftWin,
    RightWin,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub enum ModifierBase {
    Ctrl,
    Alt,
    Shift,
    Cmd,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub enum ModifierSide {
    Any,
    Left,
    Right,
}

impl Modifier {
    pub fn base(self) -> ModifierBase {
        match self {
            Modifier::Ctrl | Modifier::LeftCtrl | Modifier::RightCtrl => ModifierBase::Ctrl,
            Modifier::Alt | Modifier::LeftAlt | Modifier::RightAlt => ModifierBase::Alt,
            Modifier::Shift | Modifier::LeftShift | Modifier::RightShift => ModifierBase::Shift,
            Modifier::Cmd
            | Modifier::LeftCmd
            | Modifier::RightCmd
            | Modifier::Win
            | Modifier::LeftWin
            | Modifier::RightWin => ModifierBase::Cmd,
        }
    }

    pub fn side(self) -> ModifierSide {
        match self {
            Modifier::LeftCtrl
            | Modifier::LeftAlt
            | Modifier::LeftShift
            | Modifier::LeftCmd
            | Modifier::LeftWin => ModifierSide::Left,
            Modifier::RightCtrl
            | Modifier::RightAlt
            | Modifier::RightShift
            | Modifier::RightCmd
            | Modifier::RightWin => ModifierSide::Right,
            Modifier::Ctrl | Modifier::Alt | Modifier::Shift | Modifier::Cmd | Modifier::Win => {
                ModifierSide::Any
            }
        }
    }
}

/// Bitmask of physically-held modifiers at the moment of a non-modifier
/// key press. Used to disambiguate `keys: [1]`, `keys: [shift, 1]`, and
/// `keys: [right_shift, 1]` in explicit-override rules.
///
/// `Cmd` and `Win` share a bit since the state machine treats them as the
/// same logical modifier (Cmd on macOS, Win on Windows).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Default)]
pub struct ModifierMask(u16);

impl ModifierMask {
    pub const EMPTY: Self = Self(0);

    const CTRL_BIT: u16 = 1 << 0;
    const LEFT_CTRL_BIT: u16 = 1 << 1;
    const RIGHT_CTRL_BIT: u16 = 1 << 2;
    const ALT_BIT: u16 = 1 << 3;
    const LEFT_ALT_BIT: u16 = 1 << 4;
    const RIGHT_ALT_BIT: u16 = 1 << 5;
    const SHIFT_BIT: u16 = 1 << 6;
    const LEFT_SHIFT_BIT: u16 = 1 << 7;
    const RIGHT_SHIFT_BIT: u16 = 1 << 8;
    const CMD_BIT: u16 = 1 << 9;
    const LEFT_CMD_BIT: u16 = 1 << 10;
    const RIGHT_CMD_BIT: u16 = 1 << 11;

    pub fn insert(&mut self, m: Modifier) {
        self.0 |= Self::bit(m);
    }

    pub fn remove(&mut self, m: Modifier) {
        self.0 &= !Self::remove_bits(m);
    }

    pub fn is_empty(self) -> bool {
        self.0 == 0
    }

    pub fn contains(self, m: Modifier) -> bool {
        self.0 & Self::match_bits(m) != 0
    }

    #[cfg_attr(target_os = "windows", allow(dead_code))]
    pub fn contains_exact(self, m: Modifier) -> bool {
        self.0 & Self::bit(m) != 0
    }

    /// A one-modifier mask. Convenience for the many call sites holding a
    /// single logical modifier (transparent-modifier layers, single-modifier
    /// fallbacks).
    pub fn just(m: Modifier) -> Self {
        let mut mask = Self::EMPTY;
        mask.insert(m);
        mask
    }

    /// The exact modifiers set in this mask, in a stable canonical order
    /// (ctrl → alt → shift → cmd, unsided before sided). Side precision is
    /// preserved — `LEFT_SHIFT_BIT` decodes back to `Modifier::LeftShift`.
    /// `Cmd`/`Win` share a bit, so the `Cmd` spelling is returned; both map
    /// to the same VK / CGEventFlag downstream, so the distinction is
    /// immaterial for the modifier-down/up events this feeds.
    pub fn modifiers(self) -> SmallVec<[Modifier; 4]> {
        const BITS: [(u16, Modifier); 12] = [
            (ModifierMask::CTRL_BIT, Modifier::Ctrl),
            (ModifierMask::LEFT_CTRL_BIT, Modifier::LeftCtrl),
            (ModifierMask::RIGHT_CTRL_BIT, Modifier::RightCtrl),
            (ModifierMask::ALT_BIT, Modifier::Alt),
            (ModifierMask::LEFT_ALT_BIT, Modifier::LeftAlt),
            (ModifierMask::RIGHT_ALT_BIT, Modifier::RightAlt),
            (ModifierMask::SHIFT_BIT, Modifier::Shift),
            (ModifierMask::LEFT_SHIFT_BIT, Modifier::LeftShift),
            (ModifierMask::RIGHT_SHIFT_BIT, Modifier::RightShift),
            (ModifierMask::CMD_BIT, Modifier::Cmd),
            (ModifierMask::LEFT_CMD_BIT, Modifier::LeftCmd),
            (ModifierMask::RIGHT_CMD_BIT, Modifier::RightCmd),
        ];
        BITS.iter()
            .filter(|(bit, _)| self.0 & bit != 0)
            .map(|(_, m)| *m)
            .collect()
    }

    /// Merge a coarse flag-derived mask without losing side precision from
    /// platform tracking. This is mainly for macOS: CGEventFlags says "Shift
    /// is down" but not which Shift, while FlagsChanged events do carry the
    /// physical keycode.
    #[cfg_attr(target_os = "windows", allow(dead_code))]
    pub fn merge_missing_bases(&mut self, other: ModifierMask) {
        for m in [
            Modifier::Ctrl,
            Modifier::Alt,
            Modifier::Shift,
            Modifier::Cmd,
        ] {
            if !self.contains(m) && other.contains(m) {
                self.insert(m);
            }
        }
    }

    /// Candidate masks for explicit rule lookup. The first candidate is the
    /// exact physical-side mask. Later candidates generalize each active
    /// modifier base to its unsided form so `keys: [shift, 1]` still matches a
    /// left- or right-shift physical press, while `keys: [right_shift, 1]`
    /// remains side-specific.
    pub fn lookup_candidates(self) -> SmallVec<[ModifierMask; 16]> {
        let mut candidates: SmallVec<[ModifierMask; 16]> = SmallVec::new();
        candidates.push(ModifierMask::EMPTY);

        for base in [
            ModifierBase::Ctrl,
            ModifierBase::Alt,
            ModifierBase::Shift,
            ModifierBase::Cmd,
        ] {
            let choices = self.base_choices(base);
            if choices.is_empty() {
                continue;
            }

            let existing = candidates.clone();
            candidates.clear();
            for prefix in existing {
                for choice in &choices {
                    candidates.push(ModifierMask(prefix.0 | choice.0));
                }
            }
        }

        candidates
    }

    fn bit(m: Modifier) -> u16 {
        match m {
            Modifier::Ctrl => Self::CTRL_BIT,
            Modifier::LeftCtrl => Self::LEFT_CTRL_BIT,
            Modifier::RightCtrl => Self::RIGHT_CTRL_BIT,
            Modifier::Alt => Self::ALT_BIT,
            Modifier::LeftAlt => Self::LEFT_ALT_BIT,
            Modifier::RightAlt => Self::RIGHT_ALT_BIT,
            Modifier::Shift => Self::SHIFT_BIT,
            Modifier::LeftShift => Self::LEFT_SHIFT_BIT,
            Modifier::RightShift => Self::RIGHT_SHIFT_BIT,
            Modifier::Cmd | Modifier::Win => Self::CMD_BIT,
            Modifier::LeftCmd | Modifier::LeftWin => Self::LEFT_CMD_BIT,
            Modifier::RightCmd | Modifier::RightWin => Self::RIGHT_CMD_BIT,
        }
    }

    fn match_bits(m: Modifier) -> u16 {
        match m.side() {
            ModifierSide::Any => Self::base_bits(m.base()),
            ModifierSide::Left | ModifierSide::Right => Self::bit(m) | Self::unsided_bit(m.base()),
        }
    }

    fn remove_bits(m: Modifier) -> u16 {
        match m.side() {
            ModifierSide::Any => Self::base_bits(m.base()),
            ModifierSide::Left | ModifierSide::Right => Self::bit(m),
        }
    }

    fn base_bits(base: ModifierBase) -> u16 {
        match base {
            ModifierBase::Ctrl => Self::CTRL_BIT | Self::LEFT_CTRL_BIT | Self::RIGHT_CTRL_BIT,
            ModifierBase::Alt => Self::ALT_BIT | Self::LEFT_ALT_BIT | Self::RIGHT_ALT_BIT,
            ModifierBase::Shift => Self::SHIFT_BIT | Self::LEFT_SHIFT_BIT | Self::RIGHT_SHIFT_BIT,
            ModifierBase::Cmd => Self::CMD_BIT | Self::LEFT_CMD_BIT | Self::RIGHT_CMD_BIT,
        }
    }

    fn unsided_bit(base: ModifierBase) -> u16 {
        match base {
            ModifierBase::Ctrl => Self::CTRL_BIT,
            ModifierBase::Alt => Self::ALT_BIT,
            ModifierBase::Shift => Self::SHIFT_BIT,
            ModifierBase::Cmd => Self::CMD_BIT,
        }
    }

    fn base_choices(self, base: ModifierBase) -> SmallVec<[ModifierMask; 2]> {
        let bits = self.0 & Self::base_bits(base);
        let mut choices = SmallVec::new();
        if bits == 0 {
            return choices;
        }

        let exact = ModifierMask(bits & !Self::unsided_bit(base));
        if !exact.is_empty() {
            choices.push(exact);
        }
        choices.push(ModifierMask(Self::unsided_bit(base)));
        choices
    }
}

impl FromIterator<Modifier> for ModifierMask {
    fn from_iter<I: IntoIterator<Item = Modifier>>(iter: I) -> Self {
        let mut mask = Self::EMPTY;
        for m in iter {
            mask.insert(m);
        }
        mask
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
    /// The Windows "Application" / Menu key (`VK_APPS`) — opens a context
    /// menu, the target of AutoHotkey's `{AppsKey}`. Windows-only: macOS has
    /// no equivalent key, so synthesis there is a no-op (use `[shift, f10]`
    /// on macOS instead).
    Apps,
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
    /// Switch the system input language / keyboard layout to the one
    /// matching this code (e.g. `en`, `ru`). The language must already be
    /// installed as a system input source — we only activate, never add.
    ChangeLanguage(LanguageCode),
}

/// A short ASCII language tag (e.g. `en`, `ru`, `en-us`). Stored as a
/// fixed-size buffer so `SyntheticEvent` can stay `Copy`. Up to 8 bytes;
/// trailing zeros pad the tail.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub struct LanguageCode([u8; 8]);

impl LanguageCode {
    pub fn parse(s: &str) -> Result<Self, String> {
        let trimmed = s.trim();
        if trimmed.is_empty() {
            return Err("change_language: empty value".into());
        }
        let bytes = trimmed.as_bytes();
        if bytes.len() > 8 {
            return Err(format!(
                "change_language: '{trimmed}' too long (max 8 chars)"
            ));
        }
        if !bytes
            .iter()
            .all(|b| b.is_ascii_alphanumeric() || *b == b'-' || *b == b'_')
        {
            return Err(format!(
                "change_language: '{trimmed}' must be ASCII alphanumeric (with optional - / _)"
            ));
        }
        let mut buf = [0u8; 8];
        for (i, b) in bytes.iter().enumerate() {
            buf[i] = b.to_ascii_lowercase();
        }
        Ok(LanguageCode(buf))
    }

    pub fn as_str(&self) -> &str {
        let end = self.0.iter().position(|&b| b == 0).unwrap_or(self.0.len());
        // Safe: `parse` only stores ASCII bytes.
        std::str::from_utf8(&self.0[..end]).unwrap_or("")
    }
}

// ---------------------------------------------------------------------------
// Resolved form — what the state machine consumes.

#[derive(Debug, Clone)]
pub struct ResolvedRules {
    /// Per-trigger bindings keyed by the logical key the trigger corresponds
    /// to. The state machine does `triggers.get(&incoming_key)` to decide
    /// whether a key should enter Pending.
    pub triggers: HashMap<LogicalKey, ResolvedBinding>,
    /// macOS-only: modifier(s) runwa chords with the desktop digit when it
    /// fires a `switch_to_workspace` / `move_to_workspace` action. Must match
    /// the combo bound to Mission Control's "Switch to Desktop N" shortcut.
    /// Sourced from `settings.macos_switch_workspace_modifiers`; defaults to
    /// `[Ctrl]` (macOS's factory binding). Ignored on other platforms.
    pub macos_switch_workspace_modifiers: SmallVec<[Modifier; 4]>,
}

impl Default for ResolvedRules {
    fn default() -> Self {
        Self {
            triggers: HashMap::new(),
            macos_switch_workspace_modifiers: smallvec::smallvec![Modifier::Ctrl],
        }
    }
}

#[derive(Debug, Clone)]
pub struct ResolvedBinding {
    /// Events emitted when the trigger is pressed and released with no
    /// other key in between. `None` = no-op.
    pub on_tap: Option<Vec<SyntheticEvent>>,
    pub on_hold: ResolvedHold,
}

impl ResolvedBinding {
    /// True when this trigger's `on_hold` has at least one explicit
    /// override keyed by a modifier mask that includes `m`. Used by the
    /// preempt-from-Pending path to decide whether holding e.g. Shift and
    /// then pressing this trigger should switch into its layer (because
    /// the layer has `keys: [shift, …]` rules) or pass through as an OS
    /// chord like Shift+Tab.
    pub fn uses_modifier(&self, m: Modifier) -> bool {
        match &self.on_hold {
            ResolvedHold::Explicit { overrides, .. } => {
                overrides.keys().any(|(mask, _)| mask.contains(m))
            }
            ResolvedHold::TransparentModifier(_) | ResolvedHold::Passthrough => false,
        }
    }
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
        overrides: HashMap<(ModifierMask, NamedKey), EmitPair>,
        /// Fallback modifiers for unmapped combos, empty when none. Sourced
        /// from a rule whose `keys: [any]` (legacy `[_default]`) lists one or
        /// more modifiers in `to_hotkey`, e.g. `to_hotkey: [ctrl, shift]`.
        /// While the trigger is held, a key without an explicit override is
        /// forwarded with all of these modifiers stamped on it.
        fallback: ModifierMask,
    },
    /// Hold does nothing special — behave as the raw key. Used when the
    /// user wants to remap only `on_tap` without a layer.
    Passthrough,
}

/// Split synthesis sequence for an on_hold combo emit. The state
/// machine fires `on_press` when the user's combo KeyDown lands and
/// stashes `on_release` for the matching KeyUp — that turns a
/// keyboard-remap chord into a real "hold the modifiers while the
/// physical key is held" event stream, instead of a microsecond tap.
///
/// Most rules produce a balanced pair: `to_hotkey: [ctrl, alt, cmd, d]`
/// emits `[ModDown(Ctrl), ModDown(Alt), ModDown(Cmd), KeyDown(D)]` on
/// press and the inverse on release. Workspace / language actions are
/// fire-and-forget — they all go into `on_press` and leave `on_release`
/// empty.
#[derive(Debug, Clone)]
pub struct EmitPair {
    pub on_press: SmallVec<[SyntheticEvent; 4]>,
    pub on_release: SmallVec<[SyntheticEvent; 4]>,
}

impl EmitPair {
    /// Empty pair — used for fire-and-forget actions that have nothing
    /// to undo on release (`switch_to_workspace`, `change_language`).
    pub fn press_only(events: impl IntoIterator<Item = SyntheticEvent>) -> Self {
        EmitPair {
            on_press: events.into_iter().collect(),
            on_release: SmallVec::new(),
        }
    }

    /// Flatten the pair into a single `press+release` tap sequence. Used
    /// when the same `to_hotkey: […]` token list is also wired up as an
    /// `on_tap` (a momentary chord on tap-and-release), where push-to-
    /// talk semantics don't apply.
    pub fn into_flat_tap(self) -> Vec<SyntheticEvent> {
        let mut out = Vec::with_capacity(self.on_press.len() + self.on_release.len());
        out.extend(self.on_press);
        out.extend(self.on_release);
        out
    }
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

/// Reserved top-level `settings:` block — global options that aren't
/// per-key triggers. `parse` pulls this key out of the mapping before the
/// remaining entries are read as triggers. All fields optional; omit the
/// whole block for defaults.
#[derive(Debug, Default, Deserialize)]
#[serde(deny_unknown_fields)]
struct Settings {
    /// macOS only: which modifier(s) to synthesize alongside the desktop
    /// digit for `switch_to_workspace` / `move_to_workspace`. Must match the
    /// combo bound to System Settings → Keyboard → Shortcuts → Mission
    /// Control → "Switch to Desktop N". Defaults to `[ctrl]` (the factory
    /// binding); set e.g. `[ctrl, opt, cmd]` if you've rebound it.
    #[serde(default)]
    macos_switch_workspace_modifiers: Option<Vec<YamlToken>>,
}

impl Settings {
    /// Resolve the configured Space-switch chord to concrete modifiers,
    /// falling back to `[Ctrl]` when the block or field is absent.
    fn resolve_switch_modifiers(&self) -> Result<SmallVec<[Modifier; 4]>, String> {
        let Some(tokens) = &self.macos_switch_workspace_modifiers else {
            return Ok(smallvec::smallvec![Modifier::Ctrl]);
        };
        if tokens.is_empty() {
            return Err(
                "settings.macos_switch_workspace_modifiers must list at least one modifier".into(),
            );
        }
        tokens
            .iter()
            .map(|t| {
                parse_modifier(t.as_str()).ok_or_else(|| {
                    format!(
                        "settings.macos_switch_workspace_modifiers: '{}' is not a modifier name \
                         (expected ctrl, alt/opt, shift, cmd, …)",
                        t.as_str()
                    )
                })
            })
            .collect()
    }
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
        let rules: Vec<HoldRule> =
            serde_yml::from_value(v.clone()).map_err(|e| format!("on_hold rules list: {e}"))?;
        return Ok(HoldSpec::Rules(rules));
    }
    Err(format!(
        "on_hold must be a scalar modifier name, a single-modifier list like [ctrl], \
         or a list of rule objects, got {v:?}"
    ))
}

/// A single rule inside an `on_hold:` list. Exactly one of the action
/// fields (`to_hotkey` / `switch_to_workspace` / `move_to_workspace` /
/// `change_language`) must be populated; having zero or multiple is a
/// parse error.
///
/// `keys`, `to_hotkey` and `change_language` are `YamlToken` / lists of
/// them so YAML can supply either a string (`keys: [w]`, `keys: [","]`,
/// `change_language: ru`) or an integer (`keys: [1]`) — both become
/// strings internally.
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
    #[serde(default)]
    change_language: Option<YamlToken>,
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
    let mut root: serde_yml::Value = serde_yml::from_str(yaml).map_err(|e| format!("{e}"))?;
    let mapping = root
        .as_mapping_mut()
        .ok_or_else(|| "top level of keyboard-rules.yaml must be a mapping".to_string())?;

    // Pull the reserved `settings:` block out before the rest is read as
    // triggers — otherwise `settings` would parse as an (invalid) trigger key.
    let settings = match mapping.remove("settings") {
        Some(v) => serde_yml::from_value::<Settings>(v).map_err(|e| format!("settings: {e}"))?,
        None => Settings::default(),
    };
    let macos_switch_workspace_modifiers = settings.resolve_switch_modifiers()?;

    let cfg: Config = serde_yml::from_value(root).map_err(|e| format!("{e}"))?;
    let mut triggers: HashMap<LogicalKey, ResolvedBinding> = HashMap::new();
    for (name, remap) in &cfg {
        let key = parse_trigger_key(name).ok_or_else(|| {
            format!(
                "unknown trigger key '{name}' at top level — expected a logical key name like \
                 capslock, space, shift/right_shift, ctrl/left_ctrl, alt/right_alt, cmd/left_cmd, \
                 a letter, a named key (escape/tab/…), or a punctuation alias (or the reserved \
                 `settings:` block)"
            )
        })?;
        let binding = resolve_binding(key, remap)?;
        triggers.insert(key, binding);
    }
    Ok(ResolvedRules {
        triggers,
        macos_switch_workspace_modifiers,
    })
}

fn resolve_binding(trigger: LogicalKey, remap: &KeyRemap) -> Result<ResolvedBinding, String> {
    let on_tap = match &remap.on_tap {
        None => None,
        Some(v) => match parse_tap_spec(v)? {
            // `on_tap` IS a press-and-release tap by definition — flatten
            // the split pair back into a single event list so the state
            // machine's tap-emit path stays a Vec<SyntheticEvent>.
            TapSpec::Single(s) => {
                Some(bake_hotkey_tokens(std::slice::from_ref(&s))?.into_flat_tap())
            }
            TapSpec::Combo(items) => Some(bake_hotkey_tokens(items.as_slice())?.into_flat_tap()),
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
                let mut overrides: HashMap<(ModifierMask, NamedKey), EmitPair> = HashMap::new();
                let mut fallback = ModifierMask::EMPTY;

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

                    // The fallback-combo sentinel. `any` is the canonical form;
                    // `_default` is accepted as a legacy alias so existing
                    // user YAMLs keep parsing. Same semantics either way.
                    if trigger_raw.eq_ignore_ascii_case("any")
                        || trigger_raw.eq_ignore_ascii_case("_default")
                    {
                        if !mods_tokens.is_empty() {
                            return Err(format!(
                                "rule '{}': [any] cannot be prefixed with modifiers",
                                rule.description.as_deref().unwrap_or("<unnamed>"),
                            ));
                        }
                        let to = rule.to_hotkey.as_deref().ok_or_else(|| {
                            "rule with keys: [any] must use `to_hotkey: [<modifier>, ...]`"
                                .to_string()
                        })?;
                        if to.is_empty() {
                            return Err(
                                "rule with keys: [any] must list at least one modifier in \
                                 to_hotkey"
                                    .to_string(),
                            );
                        }
                        // A fallback stamps modifiers onto whatever key the
                        // user actually presses, so every token must be a
                        // modifier — there's no trigger key to name here.
                        for tok in to {
                            match parse_modifier(tok.as_str()) {
                                Some(m) => fallback.insert(m),
                                None => {
                                    return Err(format!(
                                        "rule with keys: [any] to_hotkey accepts modifiers only \
                                         (ctrl/alt/shift/cmd/win), got '{}'",
                                        tok.as_str()
                                    ))
                                }
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
                                 expected ctrl/alt/shift/cmd/win, optionally prefixed with left_ or right_",
                                rule.description.as_deref().unwrap_or("<unnamed>"),
                                t.as_str(),
                            ))
                        }
                    }
                    }

                    let trigger_key = parse_named_key(trigger_raw)
                        .ok_or_else(|| format!("unknown trigger key '{trigger_raw}' in rule"))?;

                    let events = bake_rule_action(rule)?;
                    overrides.insert((mods, trigger_key), events);
                }

                ResolvedHold::Explicit {
                    overrides,
                    fallback,
                }
            }
        },
    };

    Ok(ResolvedBinding { on_tap, on_hold })
}

/// Pick the action out of a HoldRule and bake it into an `EmitPair`.
/// Exactly one of `to_hotkey` / `switch_to_workspace` /
/// `move_to_workspace` / `change_language` must be populated.
///
/// `to_hotkey` produces a balanced press/release pair (modifiers held
/// while the combo key is held). Workspace + language actions are
/// fire-and-forget — they go in `on_press` with an empty
/// `on_release`, because there's nothing to undo when the user lets
/// the combo key up.
fn bake_rule_action(rule: &HoldRule) -> Result<EmitPair, String> {
    let mut provided: SmallVec<[&'static str; 4]> = SmallVec::new();
    if rule.to_hotkey.is_some() {
        provided.push("to_hotkey");
    }
    if rule.switch_to_workspace.is_some() {
        provided.push("switch_to_workspace");
    }
    if rule.move_to_workspace.is_some() {
        provided.push("move_to_workspace");
    }
    if rule.change_language.is_some() {
        provided.push("change_language");
    }
    let name = rule.description.as_deref().unwrap_or("<unnamed>");
    match provided.as_slice() {
        [] => Err(format!(
            "rule '{name}' needs exactly one of: to_hotkey, switch_to_workspace, move_to_workspace, change_language"
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
            Ok(EmitPair::press_only([SyntheticEvent::SwitchToWorkspace(n)]))
        }
        ["move_to_workspace"] => {
            let n = rule.move_to_workspace.unwrap();
            if n == 0 {
                return Err(format!("rule '{name}': move_to_workspace must be >= 1"));
            }
            Ok(EmitPair::press_only([SyntheticEvent::MoveToWorkspace(n)]))
        }
        ["change_language"] => {
            let token = rule.change_language.as_ref().unwrap();
            let code = LanguageCode::parse(token.as_str())
                .map_err(|e| format!("rule '{name}': {e}"))?;
            Ok(EmitPair::press_only([SyntheticEvent::ChangeLanguage(code)]))
        }
        _ => unreachable!(),
    }
}

/// Pre-bake a hotkey token list into a split press/release sequence.
/// Every entry is a modifier except (optionally) the last — which may
/// be a named key or a single alpha.
///
/// The `EmitPair` shape exists so the state machine can hold the
/// chord for as long as the combo key is physically held: press
/// fires on KeyDown, release fires on KeyUp. Existing `on_tap`
/// users who want the old "all events at once" tap behaviour flatten
/// the pair via `EmitPair::into_flat_tap`.
fn bake_hotkey_tokens(tokens: &[String]) -> Result<EmitPair, String> {
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
            None => return Err(format!("unknown modifier '{m}' in hotkey {tokens:?}")),
        }
    }

    // If the "last" token is itself a modifier, treat the whole list as
    // "hold these modifiers" — no key. This is the transparent-fallback
    // shape (single modifier, e.g. `[cmd]`) but generalised.
    if let Some(m) = parse_modifier(last) {
        if mods.is_empty() {
            // e.g. `to_hotkey: [cmd]` — modifier-only press/release.
            let mut press = SmallVec::new();
            press.push(SyntheticEvent::ModifierDown(m));
            let mut release = SmallVec::new();
            release.push(SyntheticEvent::ModifierUp(m));
            return Ok(EmitPair {
                on_press: press,
                on_release: release,
            });
        }
        return Err(format!(
            "hotkey {tokens:?} is all-modifiers; the last token must be a key"
        ));
    }

    // Normal path: mods-down + key-down on press; mirror-image on release.
    let key = parse_named_key(last)
        .ok_or_else(|| format!("unknown key '{last}' in hotkey {tokens:?}"))?;

    let mut on_press: SmallVec<[SyntheticEvent; 4]> = SmallVec::new();
    on_press.extend(modifier_events.iter().copied());
    on_press.push(SyntheticEvent::KeyDown(key));

    let mut on_release: SmallVec<[SyntheticEvent; 4]> = SmallVec::new();
    on_release.push(SyntheticEvent::KeyUp(key));
    for ev in modifier_events.iter().rev() {
        if let SyntheticEvent::ModifierDown(m) = ev {
            on_release.push(SyntheticEvent::ModifierUp(*m));
        }
    }

    Ok(EmitPair {
        on_press,
        on_release,
    })
}

fn parse_modifier(s: &str) -> Option<Modifier> {
    let lower = s.to_ascii_lowercase();
    let normalized = lower.replace('-', "_");
    match normalized.as_str() {
        "ctrl" | "control" => Some(Modifier::Ctrl),
        "left_ctrl" | "left_control" | "lctrl" | "lcontrol" | "ctrl_left" | "control_left" => {
            Some(Modifier::LeftCtrl)
        }
        "right_ctrl" | "right_control" | "rctrl" | "rcontrol" | "ctrl_right" | "control_right" => {
            Some(Modifier::RightCtrl)
        }
        "alt" | "option" | "opt" => Some(Modifier::Alt),
        "left_alt" | "left_option" | "left_opt" | "lalt" | "loption" | "lopt" | "alt_left"
        | "option_left" | "opt_left" => Some(Modifier::LeftAlt),
        "right_alt" | "right_option" | "right_opt" | "ralt" | "roption" | "ropt" | "alt_right"
        | "option_right" | "opt_right" => Some(Modifier::RightAlt),
        "shift" => Some(Modifier::Shift),
        "left_shift" | "lshift" | "shift_left" => Some(Modifier::LeftShift),
        "right_shift" | "rshift" | "shift_right" => Some(Modifier::RightShift),
        "cmd" | "command" | "meta" => Some(Modifier::Cmd),
        "left_cmd" | "left_command" | "left_meta" | "lcmd" | "lcommand" | "lmeta" | "cmd_left"
        | "command_left" | "meta_left" => Some(Modifier::LeftCmd),
        "right_cmd" | "right_command" | "right_meta" | "rcmd" | "rcommand" | "rmeta"
        | "cmd_right" | "command_right" | "meta_right" => Some(Modifier::RightCmd),
        "win" | "super" => Some(Modifier::Win),
        "left_win" | "left_super" | "lwin" | "lsuper" | "win_left" | "super_left" => {
            Some(Modifier::LeftWin)
        }
        "right_win" | "right_super" | "rwin" | "rsuper" | "win_right" | "super_right" => {
            Some(Modifier::RightWin)
        }
        _ => None,
    }
}

/// Resolve a top-level trigger name (as written in the YAML) to the
/// `LogicalKey` the state machine matches on. Accepts modifier names
/// (`shift`, `ctrl`, …) plus everything `parse_named_key` understands,
/// plus the non-Named triggers `capslock` and `space`.
fn parse_trigger_key(name: &str) -> Option<LogicalKey> {
    let lower = name.to_ascii_lowercase();
    let normalized = lower.replace('-', "_");
    match normalized.as_str() {
        "capslock" | "caps_lock" | "caps-lock" => Some(LogicalKey::CapsLock),
        "space" => Some(LogicalKey::Space),
        "shift" => Some(LogicalKey::Shift),
        "left_shift" | "lshift" | "shift_left" => Some(LogicalKey::LeftShift),
        "right_shift" | "rshift" | "shift_right" => Some(LogicalKey::RightShift),
        "ctrl" | "control" => Some(LogicalKey::Ctrl),
        "left_ctrl" | "left_control" | "lctrl" | "lcontrol" | "ctrl_left" | "control_left" => {
            Some(LogicalKey::LeftCtrl)
        }
        "right_ctrl" | "right_control" | "rctrl" | "rcontrol" | "ctrl_right" | "control_right" => {
            Some(LogicalKey::RightCtrl)
        }
        "alt" | "option" | "opt" => Some(LogicalKey::Alt),
        "left_alt" | "left_option" | "left_opt" | "lalt" | "loption" | "lopt" | "alt_left"
        | "option_left" | "opt_left" => Some(LogicalKey::LeftAlt),
        "right_alt" | "right_option" | "right_opt" | "ralt" | "roption" | "ropt" | "alt_right"
        | "option_right" | "opt_right" => Some(LogicalKey::RightAlt),
        "cmd" | "command" | "meta" | "win" | "super" => Some(LogicalKey::Cmd),
        "left_cmd" | "left_command" | "left_meta" | "left_win" | "left_super" | "lcmd"
        | "lcommand" | "lmeta" | "lwin" | "lsuper" | "cmd_left" | "command_left" | "meta_left"
        | "win_left" | "super_left" => Some(LogicalKey::LeftCmd),
        "right_cmd" | "right_command" | "right_meta" | "right_win" | "right_super" | "rcmd"
        | "rcommand" | "rmeta" | "rwin" | "rsuper" | "cmd_right" | "command_right"
        | "meta_right" | "win_right" | "super_right" => Some(LogicalKey::RightCmd),
        _ => parse_named_key(&lower).map(LogicalKey::Named),
    }
}

/// Sensible `on_hold` default when the user didn't write one. For a
/// modifier trigger (Shift/Ctrl/Alt/Cmd, sided or unsided) we default to a transparent
/// layer of that same modifier — otherwise a `shift: { on_tap: [cmd,
/// space] }` rule would swallow the user's real Shift usage (Shift+L
/// would arrive as lowercase l because we'd suppress Shift-down waiting
/// for tap-vs-hold). For non-modifier triggers (CapsLock, Space, …)
/// Passthrough is correct — the trigger is consumed and the interrupting
/// key goes through naked.
fn default_on_hold(trigger: LogicalKey) -> ResolvedHold {
    match trigger {
        LogicalKey::Shift => ResolvedHold::TransparentModifier(Modifier::Shift),
        LogicalKey::LeftShift => ResolvedHold::TransparentModifier(Modifier::LeftShift),
        LogicalKey::RightShift => ResolvedHold::TransparentModifier(Modifier::RightShift),
        LogicalKey::Ctrl => ResolvedHold::TransparentModifier(Modifier::Ctrl),
        LogicalKey::LeftCtrl => ResolvedHold::TransparentModifier(Modifier::LeftCtrl),
        LogicalKey::RightCtrl => ResolvedHold::TransparentModifier(Modifier::RightCtrl),
        LogicalKey::Alt => ResolvedHold::TransparentModifier(Modifier::Alt),
        LogicalKey::LeftAlt => ResolvedHold::TransparentModifier(Modifier::LeftAlt),
        LogicalKey::RightAlt => ResolvedHold::TransparentModifier(Modifier::RightAlt),
        LogicalKey::Cmd => ResolvedHold::TransparentModifier(Modifier::Cmd),
        LogicalKey::LeftCmd => ResolvedHold::TransparentModifier(Modifier::LeftCmd),
        LogicalKey::RightCmd => ResolvedHold::TransparentModifier(Modifier::RightCmd),
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
        // Context-menu key. `apps` / `menu` mirror AutoHotkey's `{AppsKey}`.
        "apps" | "appskey" | "menu" | "contextmenu" | "context_menu" => Some(NamedKey::Apps),
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

#[cfg(test)]
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
            ResolvedHold::Explicit {
                overrides,
                fallback,
            } => {
                assert_eq!(*fallback, ModifierMask::just(Modifier::Cmd));
                let pair = overrides.get(&ov(alpha('W'))).expect("W override present");
                assert_eq!(
                    pair.on_press.as_slice(),
                    &[
                        SyntheticEvent::ModifierDown(Modifier::Ctrl),
                        SyntheticEvent::ModifierDown(Modifier::Alt),
                        SyntheticEvent::KeyDown(alpha('S')),
                    ]
                );
                assert_eq!(
                    pair.on_release.as_slice(),
                    &[
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
    fn any_fallback_accepts_multiple_modifiers() {
        let src = r#"
tab:
  on_tap: [tab]
  on_hold:
    - { keys: [j], to_hotkey: [ctrl, tab] }
    - { keys: [any], to_hotkey: [ctrl, shift] }
"#;
        let r = parse(src).unwrap();
        let t = binding(&r, LogicalKey::Named(NamedKey::Tab));
        match &t.on_hold {
            ResolvedHold::Explicit { fallback, .. } => {
                assert_eq!(
                    *fallback,
                    ModifierMask::from_iter([Modifier::Ctrl, Modifier::Shift])
                );
            }
            other => panic!("expected Explicit, got {other:?}"),
        }
    }

    #[test]
    fn any_fallback_rejects_non_modifier_token() {
        let src = r#"
tab:
  on_tap: [tab]
  on_hold:
    - { keys: [any], to_hotkey: [ctrl, tab] }
"#;
        let err = parse(src).expect_err("non-modifier in [any] to_hotkey must fail");
        assert!(err.contains("modifiers only"), "got: {err}");
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
                // Win+` press: Win-down + `-down. Release: mirror.
                let pair = overrides.get(&ov(NamedKey::Backtick)).unwrap();
                assert_eq!(
                    pair.on_press.as_slice(),
                    &[
                        SyntheticEvent::ModifierDown(Modifier::Win),
                        SyntheticEvent::KeyDown(NamedKey::Backtick),
                    ]
                );
                assert_eq!(
                    pair.on_release.as_slice(),
                    &[
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
                // Bare arrow emit (no modifiers): press = KeyDown,
                // release = KeyUp.
                let down = overrides.get(&ov(alpha('J'))).unwrap();
                assert_eq!(
                    down.on_press.as_slice(),
                    &[SyntheticEvent::KeyDown(NamedKey::Down)]
                );
                assert_eq!(
                    down.on_release.as_slice(),
                    &[SyntheticEvent::KeyUp(NamedKey::Down)]
                );
                let up = overrides.get(&ov(alpha('K'))).unwrap();
                assert_eq!(
                    up.on_press.as_slice(),
                    &[SyntheticEvent::KeyDown(NamedKey::Up)]
                );
                assert_eq!(
                    up.on_release.as_slice(),
                    &[SyntheticEvent::KeyUp(NamedKey::Up)]
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
                // Workspace actions are fire-and-forget: press only,
                // no release events.
                let p1 = overrides.get(&ov(alpha('1'))).unwrap();
                assert_eq!(
                    p1.on_press.as_slice(),
                    &[SyntheticEvent::SwitchToWorkspace(1)]
                );
                assert!(p1.on_release.is_empty());
                let p2 = overrides.get(&ov(alpha('2'))).unwrap();
                assert_eq!(
                    p2.on_press.as_slice(),
                    &[SyntheticEvent::MoveToWorkspace(2)]
                );
                assert!(p2.on_release.is_empty());
            }
            _ => panic!(),
        }
    }

    #[test]
    fn default_switch_workspace_modifier_is_ctrl() {
        // No `settings:` block → macOS Space switches synth plain Ctrl+N,
        // matching the factory Mission Control shortcut.
        let r = parse("space:\n  on_tap: [space]\n").unwrap();
        assert_eq!(
            r.macos_switch_workspace_modifiers.as_slice(),
            &[Modifier::Ctrl]
        );
    }

    #[test]
    fn settings_switch_workspace_modifiers_parse() {
        let src = r#"
settings:
  macos_switch_workspace_modifiers: [ctrl, opt, cmd]

space:
  on_hold:
    - keys: [1]
      switch_to_workspace: 1
"#;
        let r = parse(src).expect("parse");
        assert_eq!(
            r.macos_switch_workspace_modifiers.as_slice(),
            &[Modifier::Ctrl, Modifier::Alt, Modifier::Cmd]
        );
        // The reserved `settings` key is pulled out, not read as a trigger.
        assert!(r.triggers.contains_key(&LogicalKey::Space));
    }

    #[test]
    fn settings_rejects_unknown_modifier() {
        let src = "settings:\n  macos_switch_workspace_modifiers: [ctrl, banana]\n";
        assert!(parse(src).is_err());
    }

    #[test]
    fn settings_rejects_empty_modifier_list() {
        let src = "settings:\n  macos_switch_workspace_modifiers: []\n";
        assert!(parse(src).is_err());
    }

    #[test]
    fn settings_rejects_unknown_field() {
        let src = "settings:\n  bogus: 1\n";
        assert!(parse(src).is_err());
    }

    #[test]
    fn apps_key_bakes_as_context_menu_synth() {
        // `apps` / `menu` is AutoHotkey's {AppsKey}. Baking is OS-agnostic;
        // macOS just declines to synthesize it at inject time.
        let src = r#"
space:
  on_hold:
    - keys: [m]
      to_hotkey: [apps]
"#;
        let r = parse(src).unwrap();
        match &binding(&r, LogicalKey::Space).on_hold {
            ResolvedHold::Explicit { overrides, .. } => {
                let m = overrides.get(&ov(alpha('M'))).unwrap();
                assert_eq!(
                    m.on_press.as_slice(),
                    &[SyntheticEvent::KeyDown(NamedKey::Apps)]
                );
                assert_eq!(
                    m.on_release.as_slice(),
                    &[SyntheticEvent::KeyUp(NamedKey::Apps)]
                );
            }
            _ => panic!(),
        }
    }

    #[test]
    fn change_language_action_parses() {
        let src = r#"
space:
  on_hold:
    - keys: [e]
      change_language: en
    - keys: [r]
      change_language: ru
"#;
        let r = parse(src).expect("parse");
        match &binding(&r, LogicalKey::Space).on_hold {
            ResolvedHold::Explicit { overrides, .. } => {
                let en = overrides.get(&ov(alpha('E'))).unwrap();
                match en.on_press.as_slice() {
                    [SyntheticEvent::ChangeLanguage(code)] => {
                        assert_eq!(code.as_str(), "en");
                    }
                    other => panic!("expected ChangeLanguage(en), got {other:?}"),
                }
                assert!(en.on_release.is_empty());
                let ru = overrides.get(&ov(alpha('R'))).unwrap();
                match ru.on_press.as_slice() {
                    [SyntheticEvent::ChangeLanguage(code)] => {
                        assert_eq!(code.as_str(), "ru");
                    }
                    other => panic!("expected ChangeLanguage(ru), got {other:?}"),
                }
                assert!(ru.on_release.is_empty());
            }
            _ => panic!(),
        }
    }

    #[test]
    fn change_language_normalises_case() {
        let src = r#"
space:
  on_hold:
    - keys: [e]
      change_language: EN
"#;
        let r = parse(src).expect("parse");
        match &binding(&r, LogicalKey::Space).on_hold {
            ResolvedHold::Explicit { overrides, .. } => {
                let ev = overrides.get(&ov(alpha('E'))).unwrap();
                match ev.on_press.as_slice() {
                    [SyntheticEvent::ChangeLanguage(code)] => assert_eq!(code.as_str(), "en"),
                    other => panic!("got {other:?}"),
                }
            }
            _ => panic!(),
        }
    }

    #[test]
    fn change_language_rejects_empty() {
        let src = r#"
space:
  on_hold:
    - keys: [e]
      change_language: ""
"#;
        let err = parse(src).unwrap_err();
        assert!(err.contains("empty"), "got: {err}");
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
    fn sided_modifier_trigger_names_parse() {
        let src = r#"
right_shift:
  on_tap: [escape]
left_ctrl:
  on_tap: [tab]
"#;
        let r = parse(src).unwrap();
        match &binding(&r, LogicalKey::RightShift).on_hold {
            ResolvedHold::TransparentModifier(Modifier::RightShift) => {}
            other => panic!("expected TransparentModifier(RightShift), got {other:?}"),
        }
        match &binding(&r, LogicalKey::LeftCtrl).on_hold {
            ResolvedHold::TransparentModifier(Modifier::LeftCtrl) => {}
            other => panic!("expected TransparentModifier(LeftCtrl), got {other:?}"),
        }
    }

    #[test]
    fn sided_modifier_prefixes_parse_in_rules_and_hotkeys() {
        let src = r#"
space:
  on_tap: [space]
  on_hold:
    - { keys: [right_shift, 1], to_hotkey: [right_ctrl, right_alt, delete] }
"#;
        let r = parse(src).unwrap();
        match &binding(&r, LogicalKey::Space).on_hold {
            ResolvedHold::Explicit { overrides, .. } => {
                let mut mask = ModifierMask::EMPTY;
                mask.insert(Modifier::RightShift);
                let pair = overrides
                    .get(&(mask, alpha('1')))
                    .expect("right-shift override present");
                assert_eq!(
                    pair.on_press.as_slice(),
                    &[
                        SyntheticEvent::ModifierDown(Modifier::RightCtrl),
                        SyntheticEvent::ModifierDown(Modifier::RightAlt),
                        SyntheticEvent::KeyDown(NamedKey::Delete),
                    ]
                );
                assert_eq!(
                    pair.on_release.as_slice(),
                    &[
                        SyntheticEvent::KeyUp(NamedKey::Delete),
                        SyntheticEvent::ModifierUp(Modifier::RightAlt),
                        SyntheticEvent::ModifierUp(Modifier::RightCtrl),
                    ]
                );
            }
            _ => panic!(),
        }
    }

    #[test]
    fn modifier_mask_side_matching_and_generic_fallback() {
        let mut exact = ModifierMask::EMPTY;
        exact.insert(Modifier::RightShift);
        assert!(exact.contains_exact(Modifier::RightShift));
        assert!(!exact.contains_exact(Modifier::LeftShift));
        assert!(exact.contains(Modifier::Shift));

        let candidates = exact.lookup_candidates();
        let mut generic = ModifierMask::EMPTY;
        generic.insert(Modifier::Shift);
        assert!(candidates.contains(&exact));
        assert!(candidates.contains(&generic));

        let mut tracked = ModifierMask::EMPTY;
        tracked.insert(Modifier::LeftCtrl);
        let mut flags = ModifierMask::EMPTY;
        flags.insert(Modifier::Ctrl);
        flags.insert(Modifier::Alt);
        tracked.merge_missing_bases(flags);
        assert!(tracked.contains_exact(Modifier::LeftCtrl));
        assert!(!tracked.contains_exact(Modifier::Ctrl));
        assert!(tracked.contains_exact(Modifier::Alt));
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

    - { keys: [e], change_language: en }
    - { keys: [r], change_language: ru }

    - { os: macos, keys: [_default], to_hotkey: [cmd] }
"#;
        let r = parse(src).expect("default template must parse");
        assert!(r.triggers.contains_key(&LogicalKey::CapsLock));
        assert!(r.triggers.contains_key(&LogicalKey::Shift));
        assert!(r.triggers.contains_key(&LogicalKey::Space));
        // Shift with only on_tap written — hold defaults to transparent Shift.
        match &binding(&r, LogicalKey::Shift).on_hold {
            ResolvedHold::TransparentModifier(Modifier::Shift) => {}
            other => {
                panic!("shift default on_hold should be TransparentModifier(Shift), got {other:?}")
            }
        }
    }
}
