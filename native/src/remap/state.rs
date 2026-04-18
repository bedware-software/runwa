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
    /// A single alphanumeric character (A–Z or 0–9) in ASCII uppercase.
    Alpha(u8),
    /// Anything else — punctuation, F-keys, arrow keys, etc. The state
    /// machine only needs to know "interruption happened"; the user can't
    /// bind these as triggers in the MVP.
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
}

impl Action {
    pub fn emit(events: impl IntoIterator<Item = SyntheticEvent>) -> Self {
        Action::Emit(events.into_iter().collect())
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

            // In Modifying with a held modifier: OS thinks the modifier is
            // pressed, so just forward the incoming key — it picks up the
            // modifier implicitly. In Modifying without a held mod (fired
            // explicit override): forward naked.
            (State::Modifying { .. }, _, None, _) => Action::Forward,

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
                // user wants the literal key. Emit the trigger's "natural"
                // key press (best guess) then forward the interrupt. Simpler
                // to just suppress the original press and forward the new
                // key: the user loses the trigger tap, which is consistent
                // with "Passthrough = we're in a state where Space-down got
                // swallowed". This path is intentionally rare — users who
                // don't want a hold layer should omit the trigger entirely.
                self.state = State::Modifying { trigger, held: None };
                Action::Forward
            }

            ResolvedHold::TransparentModifier(m) => {
                let m = *m;
                self.state = State::Modifying { trigger, held: Some(m) };
                Action::emit([
                    SyntheticEvent::ModifierDown(m),
                    key_down_for(other),
                ])
            }

            ResolvedHold::Explicit { overrides, fallback } => {
                // Try explicit override first.
                if let LogicalKey::Alpha(b) = other {
                    let token = String::from(b as char);
                    if let Some(events) = overrides.get(&token) {
                        self.state = State::Modifying { trigger, held: None };
                        return Action::emit(events.iter().copied());
                    }
                }

                // No override → fallback modifier, if configured.
                if let Some(m) = *fallback {
                    self.state = State::Modifying { trigger, held: Some(m) };
                    return Action::emit([
                        SyntheticEvent::ModifierDown(m),
                        key_down_for(other),
                    ]);
                }

                // No override, no fallback → forward a naked key-down.
                // Since we suppressed the trigger-down, the user otherwise
                // loses this keystroke entirely. Synthesising the key-down
                // (rather than Forward) keeps the event tagged as
                // "injected" so it won't re-enter the state machine.
                self.state = State::Modifying { trigger, held: None };
                Action::emit([key_down_for(other)])
            }
        }
    }
}

fn key_down_for(k: LogicalKey) -> SyntheticEvent {
    let named = match k {
        LogicalKey::Alpha(b) => NamedKey::Alpha(b),
        // Other keys shouldn't reach here (state machine only cares about
        // alphanumeric in overrides/fallback paths); but if they do, emit
        // Space as a visible placeholder rather than panic.
        _ => NamedKey::Space,
    };
    SyntheticEvent::KeyDown(named)
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
        LogicalKey::Alpha(c as u8)
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
        assert_eq!(m.on_event(down(alpha('V'))), Action::Forward);
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
}
