//! Platform-agnostic state machine.
//!
//! Each trigger (CapsLock, Space) carries a `ResolvedBinding` that tells the
//! engine what to emit on tap, and how to behave on hold: transparent
//! modifier, explicit per-key overrides (with optional fallback modifier),
//! or pure passthrough.
//!
//! Tap-vs-hold is decided by interruption, not time: if another key was
//! pressed between trigger-down and trigger-up, it's a hold. No timers,
//! no latency.

use smallvec::SmallVec;

use super::rules::{Modifier, NamedKey, ResolvedBinding, ResolvedHold, ResolvedRules, SyntheticEvent};

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
    /// Shift / Ctrl / Alt / Win — keys the OS uses as modifiers. We never
    /// want one of these to interrupt a Pending trigger (it would consume
    /// the layer), so they always forward and leave state untouched.
    /// Example: Space-down → Shift-down → ","-down should still fire the
    /// Space+"," override with Shift naturally held.
    #[allow(dead_code)] // constructed in windows.rs only; matched cross-platform
    SystemModifier,
    /// Anything we don't have a `NamedKey` for (media keys, F13+, layout-
    /// specific scancodes, etc.). Interruptions of this kind don't emit a
    /// synthetic keypress — they just take the state machine out of Pending.
    Other,
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
}

#[derive(Debug, PartialEq, Eq)]
pub enum Action {
    Forward,
    Suppress,
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

    pub fn emit_then_forward(events: impl IntoIterator<Item = SyntheticEvent>) -> Self {
        Action::EmitThenForward(events.into_iter().collect())
    }
}

// ---------------------------------------------------------------------------

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Trigger {
    CapsLock,
    Space,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum State {
    Idle,
    /// Trigger is physically down, nothing else has been seen yet.
    Pending { trigger: Trigger },
    /// Trigger is held and we've processed at least one other key. `held`
    /// tracks the modifier we've injected a down-for but haven't released
    /// yet (we emit the matching up on trigger release). `None` means no
    /// modifier is outstanding.
    Modifying { trigger: Trigger, held: Option<Modifier> },
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
        let (trigger_match, binding) = match ev.key {
            LogicalKey::CapsLock => (Some(Trigger::CapsLock), self.rules.capslock.as_ref()),
            LogicalKey::Space => (Some(Trigger::Space), self.rules.space.as_ref()),
            _ => (None, None),
        };

        match (self.state, ev.kind, trigger_match, binding) {
            // -----------------------------------------------------------
            // Trigger key events (CapsLock or Space — same logic, different
            // binding).
            // -----------------------------------------------------------

            // Idle + trigger-down: enter Pending if this trigger has a binding.
            (State::Idle, EventKind::KeyDown, Some(t), Some(_)) => {
                self.state = State::Pending { trigger: t };
                Action::Suppress
            }
            // Idle + trigger-down without a binding: forward.
            (State::Idle, EventKind::KeyDown, Some(_), None) => Action::Forward,

            // Autorepeat trigger-down: always suppress.
            (
                State::Pending { trigger: ts } | State::Modifying { trigger: ts, .. },
                EventKind::KeyDown,
                Some(te),
                _,
            ) if ts == te => Action::Suppress,

            // Trigger-up in Pending: pure tap — emit on_tap.
            (State::Pending { trigger: ts }, EventKind::KeyUp, Some(te), Some(b)) if ts == te => {
                self.state = State::Idle;
                match &b.on_tap {
                    Some(events) => Action::emit(events.iter().copied()),
                    None => Action::Suppress,
                }
            }

            // Trigger-up in Modifying: release held modifier (if any).
            (State::Modifying { trigger: ts, held }, EventKind::KeyUp, Some(te), _) if ts == te => {
                self.state = State::Idle;
                match held {
                    Some(m) => Action::emit([SyntheticEvent::ModifierUp(m)]),
                    None => Action::Suppress,
                }
            }

            // Trigger-up for a trigger we don't own (no binding): forward.
            (_, EventKind::KeyUp, Some(_), None) => Action::Forward,

            // -----------------------------------------------------------
            // Non-trigger key events.
            // -----------------------------------------------------------

            // System modifiers (Shift/Ctrl/Alt/Win) never interrupt or
            // consume the layer. Forward them and keep state so the next
            // real key still fires the binding.
            (_, _, None, _) if matches!(ev.key, LogicalKey::SystemModifier) => Action::Forward,

            // In Pending, a non-trigger key-down = interruption. Dispatch
            // according to the binding's on_hold mode.
            (State::Pending { trigger }, EventKind::KeyDown, None, _) => {
                let binding = match trigger {
                    Trigger::CapsLock => self.rules.capslock.clone(),
                    Trigger::Space => self.rules.space.clone(),
                };
                let Some(binding) = binding else {
                    // Shouldn't happen — we only enter Pending when the
                    // binding exists. Defensive fallback.
                    self.state = State::Idle;
                    return Action::Forward;
                };
                self.handle_interruption(trigger, &binding, ev.key)
            }

            // In Modifying{held: None} (an explicit override just fired),
            // a new key-down should re-fire the override — so holding the
            // trigger and tapping the target key repeatedly works, not
            // just the first tap.
            (State::Modifying { trigger, held: None }, EventKind::KeyDown, None, _) => {
                let binding = match trigger {
                    Trigger::CapsLock => self.rules.capslock.clone(),
                    Trigger::Space => self.rules.space.clone(),
                };
                let Some(binding) = binding else {
                    return Action::Forward;
                };
                self.handle_interruption(trigger, &binding, ev.key)
            }

            // In Modifying with a held modifier: forward the event with the
            // modifier flag asserted. Windows' SendInput already updated the
            // global key state so flags propagate naturally on that
            // platform, but macOS needs explicit per-event flag overrides.
            // Both platforms accept `ForwardWithModifier`; the macOS path
            // stamps the flag, the Windows path treats it as a plain
            // Forward.
            (State::Modifying { held: Some(m), .. }, _, None, _) => {
                Action::ForwardWithModifier(m)
            }

            // Modifying{held: None} catches key-ups orphaned by a synthetic
            // override's initial emit (harmless — no modifier to stamp).
            (State::Modifying { held: None, .. }, _, None, _) => Action::Forward,

            // Anything else: forward (includes trigger events that don't
            // match the current state's trigger — rare corner case, most
            // commonly a second trigger pressed while the first is held).
            _ => Action::Forward,
        }
    }

    fn handle_interruption(
        &mut self,
        trigger: Trigger,
        binding: &ResolvedBinding,
        other: LogicalKey,
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
                // Explicit override first — direct NamedKey lookup.
                if let LogicalKey::Named(nk) = other {
                    if let Some(events) = overrides.get(&nk) {
                        self.state = State::Modifying { trigger, held: None };
                        return Action::emit(events.iter().copied());
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
        RawEvent { kind: EventKind::KeyDown, key: k }
    }
    fn up(k: LogicalKey) -> RawEvent {
        RawEvent { kind: EventKind::KeyUp, key: k }
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

    // -----------------------------------------------------------------
    // Common fixtures

    const CAPS_CTRL_ESC: &str = r#"
capslock:
  to_hotkey:
    on_tap: escape
    on_hold: ctrl
"#;

    const SPACE_MAC: &str = r#"
capslock:
  to_hotkey:
    on_tap: escape
    on_hold: ctrl
space:
  to_hotkey:
    on_tap: space
    on_hold:
      - keys: [w]
        to_hotkey: [ctrl, alt, s]
      - keys: [_default]
        to_hotkey: [cmd]
"#;

    const SPACE_WIN: &str = r#"
space:
  to_hotkey:
    on_tap: space
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
            emit(vec![
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
  to_hotkey:
    on_tap: space
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
            emit(vec![
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
  to_hotkey:
    on_tap: space
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
  to_hotkey:
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
  to_hotkey:
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
        assert_eq!(m.on_event(down(LogicalKey::SystemModifier)), Action::Forward);
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
        assert_eq!(m.on_event(up(LogicalKey::SystemModifier)), Action::Forward);
    }

    // Pressing only a system modifier during Space (no real key) must
    // not kill the tap — Space-up still emits the on_tap space.
    #[test]
    fn system_modifier_alone_preserves_tap() {
        let mut m = sm(SPACE_WIN);
        m.on_event(down(LogicalKey::Space));
        assert_eq!(m.on_event(down(LogicalKey::SystemModifier)), Action::Forward);
        assert_eq!(m.on_event(up(LogicalKey::SystemModifier)), Action::Forward);
        assert_eq!(
            m.on_event(up(LogicalKey::Space)),
            emit(vec![
                SyntheticEvent::KeyDown(NamedKey::Space),
                SyntheticEvent::KeyUp(NamedKey::Space),
            ])
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
