//! Platform-agnostic state machine.
//!
//! Any `LogicalKey` can be a trigger — the config is a map keyed by logical
//! key name, and a `ResolvedBinding` tells the engine what to emit on tap
//! and how to behave on hold: transparent modifier, explicit per-key
//! overrides (with optional fallback modifier), or pure passthrough.
//!
//! Tap-vs-hold is decided by interruption, not time: if another key was
//! pressed between trigger-down and trigger-up, it's a hold. No timers,
//! no latency.

use smallvec::SmallVec;

use super::rules::{
    Modifier, ModifierMask, NamedKey, ResolvedBinding, ResolvedHold, ResolvedRules, SyntheticEvent,
};

/// Logical key at the state-machine boundary. Platform layers map their
/// native scancodes to this enum.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub enum LogicalKey {
    CapsLock,
    Space,
    /// A key the state machine can both match in overrides and synthesize.
    /// Covers alphanumerics (Alpha(b)), arrows, navigation, punctuation,
    /// F-keys, and named keys like Escape/Tab/Enter.
    Named(NamedKey),
    /// OS-level modifier keys. Split into distinct variants (not a single
    /// `SystemModifier`) so any of them can be a trigger with its own rule
    /// — e.g. `shift:` at the top level of the YAML config. When a
    /// modifier does NOT have a rule (or another trigger is already active),
    /// the state machine forwards it untouched so the physical modifier is
    /// still held on whatever key comes next.
    Shift,
    Ctrl,
    Alt,
    /// Cmd on macOS, Win on Windows — they're the same logical key.
    Cmd,
    /// Anything we don't have a `NamedKey` for (media keys, F13+, layout-
    /// specific scancodes, etc.). Interruptions of this kind don't emit a
    /// synthetic keypress — they just take the state machine out of Pending.
    Other,
}

impl LogicalKey {
    /// True if the key is one of the OS-level modifiers. The state machine
    /// treats these specially: they don't interrupt another trigger's
    /// layer (so e.g. Space+Shift+, still fires the Space+, override).
    pub fn is_modifier(self) -> bool {
        matches!(self, LogicalKey::Shift | LogicalKey::Ctrl | LogicalKey::Alt | LogicalKey::Cmd)
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum EventKind {
    KeyDown,
    KeyUp,
}

#[derive(Debug, Clone)]
pub struct RawEvent {
    pub kind: EventKind,
    pub key: LogicalKey,
    /// Physical modifier state at event time. Consulted only for KeyDown of
    /// non-modifier keys to pick between qualified rules (`keys: [shift, 1]`)
    /// and unqualified ones (`keys: [1]`). Platform layers populate this
    /// from the event's flag state (macOS) or `GetAsyncKeyState` (Windows).
    pub modifiers: ModifierMask,
}

#[derive(Debug, PartialEq, Eq)]
pub enum Action {
    Forward,
    Suppress,
    /// Inject these synthetic events as a standalone action — no modifier
    /// flags from the triggering event should leak into the output. Used
    /// for tap emission (Pending→Idle on trigger KeyUp) where the trigger
    /// is being released on its own; any flags on the trigger-up event
    /// are either spurious (stale synthetic state) or unrelated to the
    /// tap's intent. On Windows this is indistinguishable from `Emit`
    /// (SendInput doesn't stamp per-event flags); on macOS the injector
    /// posts with flags=0 so e.g. CapsLock-tap → Esc doesn't accidentally
    /// carry a Ctrl flag into Zed or Cmd flag into anything else.
    EmitTap(SmallVec<[SyntheticEvent; 8]>),
    /// Inject these synthetic events in the context of the current event,
    /// inheriting its flags. Used for interruptions — Space+Shift+, →
    /// Shift+Home needs the user's physically-held Shift to carry onto
    /// the synthesized Home events.
    Emit(SmallVec<[SyntheticEvent; 8]>),
    /// Inject synthetic events AND let the original event through. Used for
    /// transparent-modifier interruptions by keys we don't have a NamedKey
    /// for — we need to press the modifier but can't synthesize the key,
    /// so we pre-inject the modifier and forward the user's keystroke.
    EmitThenForward(SmallVec<[SyntheticEvent; 8]>),
    /// Forward the event but assert the given modifier on it. Used when a
    /// transparent modifier is logically held (state is `Modifying{held:
    /// Some(m)}`) and a subsequent real key event arrives. Platform layers
    /// stamp the modifier onto the event before letting it through. On
    /// Windows this is equivalent to `Forward` because `SendInput` already
    /// updated the global key state; on macOS, CGEvent posting doesn't
    /// propagate synthetic modifier-down state to real subsequent events,
    /// so the platform layer has to set the flags explicitly.
    ForwardWithModifier(Modifier),
}

impl Action {
    pub fn emit(events: impl IntoIterator<Item = SyntheticEvent>) -> Self {
        Action::Emit(events.into_iter().collect())
    }

    pub fn emit_tap(events: impl IntoIterator<Item = SyntheticEvent>) -> Self {
        Action::EmitTap(events.into_iter().collect())
    }

    pub fn emit_then_forward(events: impl IntoIterator<Item = SyntheticEvent>) -> Self {
        Action::EmitThenForward(events.into_iter().collect())
    }
}

// ---------------------------------------------------------------------------

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum State {
    Idle,
    /// Trigger is physically down, nothing else has been seen yet.
    Pending { trigger: LogicalKey },
    /// Trigger is held and we've processed at least one other key. `held`
    /// tracks the modifier we've injected a down-for but haven't released
    /// yet (we emit the matching up on trigger release). `None` means no
    /// modifier is outstanding.
    Modifying { trigger: LogicalKey, held: Option<Modifier> },
}

pub struct StateMachine {
    rules: ResolvedRules,
    state: State,
}

impl StateMachine {
    pub fn new(rules: ResolvedRules) -> Self {
        Self {
            rules,
            state: State::Idle,
        }
    }

    pub fn on_event(&mut self, ev: RawEvent) -> Action {
        // Does this key itself have a rule? Treat it as a trigger candidate
        // if it does.
        let binding = self.rules.triggers.get(&ev.key).cloned();

        // Modifier keys (Shift/Ctrl/Alt/Cmd) that aren't the trigger of an
        // already-active layer should never interrupt or consume that
        // layer. Example: while Space is Pending, a physical Shift-down
        // must pass through so the user can type Space+Shift+, to get
        // Shift+Home. Modifiers DO act as triggers themselves, but only
        // when they're pressed from Idle — once another trigger has the
        // layer, modifiers are transparent.
        let is_current_trigger = match self.state {
            State::Pending { trigger } | State::Modifying { trigger, .. } => trigger == ev.key,
            State::Idle => false,
        };
        if ev.key.is_modifier() && !matches!(self.state, State::Idle) && !is_current_trigger {
            return Action::Forward;
        }

        let trigger_match = if binding.is_some() { Some(ev.key) } else { None };

        match (self.state, ev.kind, trigger_match, binding.as_ref()) {
            // -----------------------------------------------------------
            // Trigger key events (any bound top-level key).
            // -----------------------------------------------------------

            // Idle + trigger-down: enter Pending.
            (State::Idle, EventKind::KeyDown, Some(t), Some(_)) => {
                self.state = State::Pending { trigger: t };
                Action::Suppress
            }

            // Autorepeat trigger-down on the CURRENT trigger: suppress.
            (
                State::Pending { trigger: ts } | State::Modifying { trigger: ts, .. },
                EventKind::KeyDown,
                Some(te),
                _,
            ) if ts == te => Action::Suppress,

            // Trigger-up of the CURRENT trigger in Pending: pure tap. Use
            // `EmitTap` (not `Emit`) so the macOS platform layer posts
            // the synthesized events with flags=0 rather than inheriting
            // the trigger-up event's flag state — which can include stale
            // synthetic-modifier flags and make e.g. Esc arrive as
            // Ctrl+Esc in Zed.
            (State::Pending { trigger: ts }, EventKind::KeyUp, Some(te), Some(b)) if ts == te => {
                self.state = State::Idle;
                match &b.on_tap {
                    Some(events) => Action::emit_tap(events.iter().copied()),
                    None => Action::Suppress,
                }
            }

            // Trigger-up of the CURRENT trigger in Modifying: release held
            // modifier (if any).
            (State::Modifying { trigger: ts, held }, EventKind::KeyUp, Some(te), _) if ts == te => {
                self.state = State::Idle;
                match held {
                    Some(m) => Action::emit([SyntheticEvent::ModifierUp(m)]),
                    None => Action::Suppress,
                }
            }

            // -----------------------------------------------------------
            // Non-current-trigger key events.
            //
            // These match regardless of whether the incoming key has its
            // own binding. A different trigger's down event during another
            // trigger's Pending still acts as an interruption — the active
            // layer takes precedence over the new trigger until the active
            // one is released.
            // -----------------------------------------------------------

            // In Pending, a key-down for anything that isn't the current
            // trigger = interruption. Dispatch according to the current
            // binding's on_hold mode.
            (State::Pending { trigger }, EventKind::KeyDown, _, _) => {
                let Some(binding) = self.rules.triggers.get(&trigger).cloned() else {
                    // Shouldn't happen — we only enter Pending when the
                    // binding exists. Defensive fallback.
                    self.state = State::Idle;
                    return Action::Forward;
                };
                self.handle_interruption(trigger, &binding, ev.key, ev.modifiers)
            }

            // In Modifying{held: None} (an explicit override just fired),
            // a new key-down for a non-current-trigger key should re-fire
            // the override — holding the trigger and tapping the target
            // key repeatedly works, not just the first tap.
            (State::Modifying { trigger, held: None }, EventKind::KeyDown, _, _) => {
                let Some(binding) = self.rules.triggers.get(&trigger).cloned() else {
                    return Action::Forward;
                };
                self.handle_interruption(trigger, &binding, ev.key, ev.modifiers)
            }

            // In Modifying with a held modifier: forward the event with the
            // modifier flag asserted. Windows' SendInput already updated
            // the global key state so flags propagate naturally on that
            // platform, but macOS needs explicit per-event flag overrides.
            // Both platforms accept `ForwardWithModifier`; the macOS path
            // stamps the flag, the Windows path treats it as a plain
            // Forward. Skip modifiers themselves — they forward through
            // the earlier short-circuit.
            (State::Modifying { held: Some(m), .. }, _, _, _) if !ev.key.is_modifier() => {
                Action::ForwardWithModifier(m)
            }

            // Anything else: forward. Covers Idle + key we don't bind,
            // orphan key-ups in Modifying{held: None}, etc.
            _ => Action::Forward,
        }
    }

    fn handle_interruption(
        &mut self,
        trigger: LogicalKey,
        binding: &ResolvedBinding,
        other: LogicalKey,
        mods: ModifierMask,
    ) -> Action {
        match &binding.on_hold {
            ResolvedHold::Passthrough => {
                // Hold does nothing — trigger-down was suppressed but the
                // user wants the literal key. Simpler to just suppress the
                // original press and forward the new key: the user loses
                // the trigger tap, which is consistent with "Passthrough =
                // we're in a state where Space-down got swallowed". This
                // path is intentionally rare — users who don't want a hold
                // layer should omit the trigger entirely.
                self.state = State::Modifying { trigger, held: None };
                Action::Forward
            }

            ResolvedHold::TransparentModifier(m) => {
                let m = *m;
                self.state = State::Modifying { trigger, held: Some(m) };
                match other {
                    LogicalKey::Named(nk) => Action::emit([
                        SyntheticEvent::ModifierDown(m),
                        SyntheticEvent::KeyDown(nk),
                    ]),
                    // Key we don't recognize — inject modifier-down, then
                    // let the original event through so the OS sees e.g.
                    // Ctrl+F13 naturally.
                    _ => Action::emit_then_forward([SyntheticEvent::ModifierDown(m)]),
                }
            }

            ResolvedHold::Explicit { overrides, fallback } => {
                // Explicit override lookup: try the exact (modifiers, key)
                // pair first, then fall back to the unqualified (empty,
                // key) form so rules authored without modifier prefixes
                // still fire when the user happens to be holding e.g.
                // Shift. The fallback-modifier path below then stamps the
                // physical modifier onto the synthesized output.
                if let LogicalKey::Named(nk) = other {
                    if let Some(events) = overrides.get(&(mods, nk)) {
                        self.state = State::Modifying { trigger, held: None };
                        return Action::emit(events.iter().copied());
                    }
                    if !mods.is_empty() {
                        if let Some(events) = overrides.get(&(ModifierMask::EMPTY, nk)) {
                            self.state = State::Modifying { trigger, held: None };
                            return Action::emit(events.iter().copied());
                        }
                    }
                }

                // No override → fallback modifier, if configured.
                if let Some(m) = *fallback {
                    self.state = State::Modifying { trigger, held: Some(m) };
                    return match other {
                        LogicalKey::Named(nk) => Action::emit([
                            SyntheticEvent::ModifierDown(m),
                            SyntheticEvent::KeyDown(nk),
                        ]),
                        _ => Action::emit_then_forward([SyntheticEvent::ModifierDown(m)]),
                    };
                }

                // No override, no fallback → forward the naked key.
                self.state = State::Modifying { trigger, held: None };
                match other {
                    LogicalKey::Named(nk) => Action::emit([SyntheticEvent::KeyDown(nk)]),
                    _ => Action::Forward,
                }
            }
        }
    }
}

// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;
    use crate::remap::rules::parse;

    fn sm(yaml: &str) -> StateMachine {
        StateMachine::new(parse(yaml).expect("rules parse"))
    }

    fn down(k: LogicalKey) -> RawEvent {
        RawEvent {
            kind: EventKind::KeyDown,
            key: k,
            modifiers: ModifierMask::EMPTY,
        }
    }
    fn up(k: LogicalKey) -> RawEvent {
        RawEvent {
            kind: EventKind::KeyUp,
            key: k,
            modifiers: ModifierMask::EMPTY,
        }
    }
    fn down_with_mods(k: LogicalKey, modifiers: ModifierMask) -> RawEvent {
        RawEvent {
            kind: EventKind::KeyDown,
            key: k,
            modifiers,
        }
    }
    fn alpha(c: char) -> LogicalKey {
        LogicalKey::Named(NamedKey::Alpha(c as u8))
    }

    fn named(nk: NamedKey) -> LogicalKey {
        LogicalKey::Named(nk)
    }
    fn emit(v: Vec<SyntheticEvent>) -> Action {
        Action::emit(v.into_iter())
    }
    fn emit_tap(v: Vec<SyntheticEvent>) -> Action {
        Action::emit_tap(v.into_iter())
    }

    // -----------------------------------------------------------------
    // Common fixtures

    const CAPS_CTRL_ESC: &str = r#"
capslock:
  on_tap: [escape]
  on_hold: [ctrl]
"#;

    const SPACE_MAC: &str = r#"
capslock:
  on_tap: [escape]
  on_hold: [ctrl]
space:
  on_tap: [space]
  on_hold:
    - keys: [w]
      to_hotkey: [ctrl, alt, s]
    - keys: [_default]
      to_hotkey: [cmd]
"#;

    const SPACE_WIN: &str = r#"
space:
  on_tap: [space]
  on_hold:
    - keys: [w]
      to_hotkey: [ctrl, alt, s]
    - keys: [q]
      to_hotkey: [alt, f4]
"#;

    // -----------------------------------------------------------------
    // CapsLock

    #[test]
    fn capslock_tap_emits_escape() {
        let mut m = sm(CAPS_CTRL_ESC);
        assert_eq!(m.on_event(down(LogicalKey::CapsLock)), Action::Suppress);
        assert_eq!(
            m.on_event(up(LogicalKey::CapsLock)),
            emit_tap(vec![
                SyntheticEvent::KeyDown(NamedKey::Escape),
                SyntheticEvent::KeyUp(NamedKey::Escape),
            ])
        );
    }

    #[test]
    fn capslock_hold_becomes_transparent_ctrl() {
        let mut m = sm(CAPS_CTRL_ESC);
        m.on_event(down(LogicalKey::CapsLock));
        assert_eq!(
            m.on_event(down(alpha('C'))),
            emit(vec![
                SyntheticEvent::ModifierDown(Modifier::Ctrl),
                SyntheticEvent::KeyDown(NamedKey::Alpha(b'C')),
            ])
        );
        // A subsequent key while CapsLock is still held must carry the Ctrl
        // flag forward — the OS saw our synthetic ModifierDown once, but on
        // macOS the real V keydown needs explicit flag stamping or it
        // arrives with flags=0 and gets interpreted as plain V.
        assert_eq!(
            m.on_event(down(alpha('V'))),
            Action::ForwardWithModifier(Modifier::Ctrl)
        );
        assert_eq!(
            m.on_event(up(LogicalKey::CapsLock)),
            emit(vec![SyntheticEvent::ModifierUp(Modifier::Ctrl)])
        );
    }

    #[test]
    fn capslock_autorepeat_is_suppressed() {
        let mut m = sm(CAPS_CTRL_ESC);
        m.on_event(down(LogicalKey::CapsLock));
        assert_eq!(m.on_event(down(LogicalKey::CapsLock)), Action::Suppress);
    }

    #[test]
    fn omitting_capslock_binding_leaves_it_alone() {
        let yaml = r#"
space:
  on_tap: [space]
"#;
        let mut m = sm(yaml);
        assert_eq!(m.on_event(down(LogicalKey::CapsLock)), Action::Forward);
        assert_eq!(m.on_event(up(LogicalKey::CapsLock)), Action::Forward);
    }

    // -----------------------------------------------------------------
    // Space — tap

    #[test]
    fn space_tap_emits_space() {
        let mut m = sm(SPACE_MAC);
        assert_eq!(m.on_event(down(LogicalKey::Space)), Action::Suppress);
        assert_eq!(
            m.on_event(up(LogicalKey::Space)),
            emit_tap(vec![
                SyntheticEvent::KeyDown(NamedKey::Space),
                SyntheticEvent::KeyUp(NamedKey::Space),
            ])
        );
    }

    // -----------------------------------------------------------------
    // Space — explicit override

    #[test]
    fn space_plus_w_fires_override() {
        let mut m = sm(SPACE_MAC);
        m.on_event(down(LogicalKey::Space));
        assert_eq!(
            m.on_event(down(alpha('W'))),
            emit(vec![
                SyntheticEvent::ModifierDown(Modifier::Ctrl),
                SyntheticEvent::ModifierDown(Modifier::Alt),
                SyntheticEvent::KeyDown(NamedKey::Alpha(b'S')),
                SyntheticEvent::KeyUp(NamedKey::Alpha(b'S')),
                SyntheticEvent::ModifierUp(Modifier::Alt),
                SyntheticEvent::ModifierUp(Modifier::Ctrl),
            ])
        );
        // Override fired -> no transparent modifier; Space-up suppresses.
        assert_eq!(m.on_event(up(LogicalKey::Space)), Action::Suppress);
    }

    // -----------------------------------------------------------------
    // Space — fallback transparent modifier

    #[test]
    fn space_plus_unmapped_key_on_mac_uses_fallback_cmd() {
        let mut m = sm(SPACE_MAC);
        m.on_event(down(LogicalKey::Space));
        assert_eq!(
            m.on_event(down(alpha('C'))),
            emit(vec![
                SyntheticEvent::ModifierDown(Modifier::Cmd),
                SyntheticEvent::KeyDown(NamedKey::Alpha(b'C')),
            ])
        );
        assert_eq!(
            m.on_event(up(LogicalKey::Space)),
            emit(vec![SyntheticEvent::ModifierUp(Modifier::Cmd)])
        );
    }

    // -----------------------------------------------------------------
    // Space — no fallback (Windows-ish): naked keydown passthrough

    #[test]
    fn space_plus_unmapped_without_fallback_emits_naked_key() {
        let mut m = sm(SPACE_WIN);
        m.on_event(down(LogicalKey::Space));
        assert_eq!(
            m.on_event(down(alpha('Z'))),
            emit(vec![SyntheticEvent::KeyDown(NamedKey::Alpha(b'Z'))])
        );
    }

    #[test]
    fn space_plus_q_on_windows_synthesizes_alt_f4() {
        let mut m = sm(SPACE_WIN);
        m.on_event(down(LogicalKey::Space));
        assert_eq!(
            m.on_event(down(alpha('Q'))),
            emit(vec![
                SyntheticEvent::ModifierDown(Modifier::Alt),
                SyntheticEvent::KeyDown(NamedKey::F4),
                SyntheticEvent::KeyUp(NamedKey::F4),
                SyntheticEvent::ModifierUp(Modifier::Alt),
            ])
        );
    }

    // -----------------------------------------------------------------
    // Non-trigger key events while Idle

    #[test]
    fn unrelated_keys_forward_when_idle() {
        let mut m = sm(SPACE_MAC);
        assert_eq!(m.on_event(down(alpha('A'))), Action::Forward);
        assert_eq!(m.on_event(up(alpha('A'))), Action::Forward);
    }

    // -----------------------------------------------------------------
    // Space — punctuation + arrow overrides (the new NamedKey coverage)

    #[test]
    fn space_plus_j_emits_down_arrow() {
        let src = r#"
space:
  on_tap: [space]
  on_hold:
    - keys: [j]
      to_hotkey: [down]
"#;
        let mut m = sm(src);
        m.on_event(down(LogicalKey::Space));
        assert_eq!(
            m.on_event(down(alpha('J'))),
            emit(vec![
                SyntheticEvent::KeyDown(NamedKey::Down),
                SyntheticEvent::KeyUp(NamedKey::Down),
            ])
        );
    }

    #[test]
    fn space_plus_comma_emits_home() {
        let src = r#"
space:
  on_hold:
    - keys: [","]
      to_hotkey: [home]
"#;
        let mut m = sm(src);
        m.on_event(down(LogicalKey::Space));
        assert_eq!(
            m.on_event(down(named(NamedKey::Comma))),
            emit(vec![
                SyntheticEvent::KeyDown(NamedKey::Home),
                SyntheticEvent::KeyUp(NamedKey::Home),
            ])
        );
    }

    #[test]
    fn space_plus_backtick_emits_win_backtick() {
        let src = r#"
space:
  on_hold:
    - keys: ["`"]
      to_hotkey: [win, "`"]
"#;
        let mut m = sm(src);
        m.on_event(down(LogicalKey::Space));
        assert_eq!(
            m.on_event(down(named(NamedKey::Backtick))),
            emit(vec![
                SyntheticEvent::ModifierDown(Modifier::Win),
                SyntheticEvent::KeyDown(NamedKey::Backtick),
                SyntheticEvent::KeyUp(NamedKey::Backtick),
                SyntheticEvent::ModifierUp(Modifier::Win),
            ])
        );
    }

    // Bug A: holding Space and tapping the target key twice should fire
    // the explicit override on each tap, not just the first.
    #[test]
    fn space_plus_q_refires_on_repeat_tap() {
        let mut m = sm(SPACE_WIN);
        m.on_event(down(LogicalKey::Space));
        let alt_f4 = || {
            emit(vec![
                SyntheticEvent::ModifierDown(Modifier::Alt),
                SyntheticEvent::KeyDown(NamedKey::F4),
                SyntheticEvent::KeyUp(NamedKey::F4),
                SyntheticEvent::ModifierUp(Modifier::Alt),
            ])
        };
        assert_eq!(m.on_event(down(alpha('Q'))), alt_f4());
        assert_eq!(m.on_event(up(alpha('Q'))), Action::Forward);
        // Second tap, still holding Space — must fire the override again.
        assert_eq!(m.on_event(down(alpha('Q'))), alt_f4());
        assert_eq!(m.on_event(up(alpha('Q'))), Action::Forward);
        assert_eq!(m.on_event(up(LogicalKey::Space)), Action::Suppress);
    }

    // Bug B: Space-down, then a system modifier (Shift), then the target
    // key — the modifier must not consume the Space layer, so the target
    // key still fires its override.
    #[test]
    fn system_modifier_during_pending_does_not_consume_layer() {
        let mut m = sm(SPACE_WIN);
        m.on_event(down(LogicalKey::Space));
        // Shift-down is forwarded without touching state.
        assert_eq!(m.on_event(down(LogicalKey::Shift)), Action::Forward);
        // Q still fires the override.
        assert_eq!(
            m.on_event(down(alpha('Q'))),
            emit(vec![
                SyntheticEvent::ModifierDown(Modifier::Alt),
                SyntheticEvent::KeyDown(NamedKey::F4),
                SyntheticEvent::KeyUp(NamedKey::F4),
                SyntheticEvent::ModifierUp(Modifier::Alt),
            ])
        );
        assert_eq!(m.on_event(up(LogicalKey::Shift)), Action::Forward);
    }

    // Pressing only a system modifier during Space (no real key) must
    // not kill the tap — Space-up still emits the on_tap space.
    #[test]
    fn system_modifier_alone_preserves_tap() {
        let mut m = sm(SPACE_WIN);
        m.on_event(down(LogicalKey::Space));
        assert_eq!(m.on_event(down(LogicalKey::Shift)), Action::Forward);
        assert_eq!(m.on_event(up(LogicalKey::Shift)), Action::Forward);
        assert_eq!(
            m.on_event(up(LogicalKey::Space)),
            emit_tap(vec![
                SyntheticEvent::KeyDown(NamedKey::Space),
                SyntheticEvent::KeyUp(NamedKey::Space),
            ])
        );
    }

    // Shift and Space both configured as triggers. Holding Space, then
    // pressing Shift, then pressing "," must still fire Space+",".
    // Shift is a modifier so it can't consume the Space layer.
    #[test]
    fn shift_while_space_pending_does_not_consume_layer() {
        let yaml = r#"
shift:
  on_tap: [cmd, space]
space:
  on_tap: [space]
  on_hold:
    - { keys: [","], to_hotkey: [home] }
"#;
        let mut m = sm(yaml);
        m.on_event(down(LogicalKey::Space));
        // Shift-down while Space is Pending: forwarded, state unchanged.
        assert_eq!(m.on_event(down(LogicalKey::Shift)), Action::Forward);
        // "," still fires Space's explicit override.
        assert_eq!(
            m.on_event(down(named(NamedKey::Comma))),
            emit(vec![
                SyntheticEvent::KeyDown(NamedKey::Home),
                SyntheticEvent::KeyUp(NamedKey::Home),
            ])
        );
    }

    // Modifier as a standalone trigger: tapping Shift alone emits the
    // on_tap combo (Cmd+Space); holding Shift+L still produces a Shift-
    // held capital L because modifier triggers default to a transparent
    // layer of themselves.
    #[test]
    fn shift_as_standalone_trigger_tap_and_hold() {
        let yaml = r#"
shift:
  on_tap: [cmd, space]
"#;
        let mut m = sm(yaml);

        // Tap path.
        assert_eq!(m.on_event(down(LogicalKey::Shift)), Action::Suppress);
        assert_eq!(
            m.on_event(up(LogicalKey::Shift)),
            emit_tap(vec![
                SyntheticEvent::ModifierDown(Modifier::Cmd),
                SyntheticEvent::KeyDown(NamedKey::Space),
                SyntheticEvent::KeyUp(NamedKey::Space),
                SyntheticEvent::ModifierUp(Modifier::Cmd),
            ])
        );

        // Hold path — Shift+L.
        m.on_event(down(LogicalKey::Shift));
        assert_eq!(
            m.on_event(down(alpha('L'))),
            emit(vec![
                SyntheticEvent::ModifierDown(Modifier::Shift),
                SyntheticEvent::KeyDown(NamedKey::Alpha(b'L')),
            ])
        );
        // Second L while still held: forwarded with Shift stamped.
        assert_eq!(
            m.on_event(up(alpha('L'))),
            Action::ForwardWithModifier(Modifier::Shift)
        );
        assert_eq!(
            m.on_event(down(alpha('L'))),
            Action::ForwardWithModifier(Modifier::Shift)
        );
        // Shift-up releases the held modifier.
        assert_eq!(
            m.on_event(up(LogicalKey::Shift)),
            emit(vec![SyntheticEvent::ModifierUp(Modifier::Shift)])
        );
    }

    #[test]
    fn shift_qualified_rule_fires_only_when_shift_held() {
        // Two rules for the same key: bare `[1]` and qualified `[shift, 1]`.
        // Space+1 → switch_to_workspace; Space+Shift+1 → move_to_workspace.
        // The lookup must route based on the physical Shift state on the
        // incoming keydown.
        let yaml = r#"
space:
  on_tap: [space]
  on_hold:
    - keys: [1]
      switch_to_workspace: 1
    - keys: [shift, 1]
      move_to_workspace: 1
"#;
        let mut m = sm(yaml);

        // Bare Space+1: unqualified rule fires.
        m.on_event(down(LogicalKey::Space));
        assert_eq!(
            m.on_event(down(alpha('1'))),
            emit(vec![SyntheticEvent::SwitchToWorkspace(1)])
        );
        assert_eq!(m.on_event(up(alpha('1'))), Action::Forward);
        assert_eq!(m.on_event(up(LogicalKey::Space)), Action::Suppress);

        // Space+Shift+1: qualified rule fires — the state machine sees the
        // incoming `1` keydown with Shift in its modifier mask.
        let mut shift = ModifierMask::EMPTY;
        shift.insert(Modifier::Shift);

        m.on_event(down(LogicalKey::Space));
        m.on_event(down(LogicalKey::Shift));
        assert_eq!(
            m.on_event(down_with_mods(alpha('1'), shift)),
            emit(vec![SyntheticEvent::MoveToWorkspace(1)])
        );
        assert_eq!(m.on_event(up(alpha('1'))), Action::Forward);
        assert_eq!(m.on_event(up(LogicalKey::Shift)), Action::Forward);
        assert_eq!(m.on_event(up(LogicalKey::Space)), Action::Suppress);
    }

    #[test]
    fn qualified_rule_falls_back_to_unqualified_when_absent() {
        // Only a bare rule exists for `1`. Pressing Space+Shift+1 — which
        // has a Shift modifier — should still fire the unqualified rule
        // (preserves pre-predicate behaviour so user YAMLs don't silently
        // stop firing when the user happens to hold Shift).
        let yaml = r#"
space:
  on_hold:
    - keys: [1]
      switch_to_workspace: 1
"#;
        let mut m = sm(yaml);
        m.on_event(down(LogicalKey::Space));
        let mut shift = ModifierMask::EMPTY;
        shift.insert(Modifier::Shift);
        assert_eq!(
            m.on_event(down_with_mods(alpha('1'), shift)),
            emit(vec![SyntheticEvent::SwitchToWorkspace(1)])
        );
    }

    #[test]
    fn capslock_plus_other_key_emits_ctrl_then_forwards() {
        // Ctrl+F13 (or any other unmapped non-Named key): we can't synth
        // the keystroke, so press Ctrl and let the OS see the original.
        let mut m = sm(CAPS_CTRL_ESC);
        m.on_event(down(LogicalKey::CapsLock));
        match m.on_event(down(LogicalKey::Other)) {
            Action::EmitThenForward(evs) => {
                assert_eq!(
                    evs.as_slice(),
                    &[SyntheticEvent::ModifierDown(Modifier::Ctrl)]
                );
            }
            other => panic!("expected EmitThenForward, got {other:?}"),
        }
        assert_eq!(
            m.on_event(up(LogicalKey::CapsLock)),
            emit(vec![SyntheticEvent::ModifierUp(Modifier::Ctrl)])
        );
    }
}
