//! Platform-agnostic state machine.
//!
//! Rules:
//!   - CapsLock and Space are "dual-role" keys: hold+other = modifier, tap
//!     alone = alternate key (Escape for CapsLock, Space for Space).
//!   - The tap-vs-hold decision is made solely by interruption — whether
//!     another key was pressed between down and up. Never by time. This
//!     avoids latency and timing-dependent glitches on fast roll-over input.
//!   - The state machine produces one of `Forward`, `Suppress`, or `Emit(...)`
//!     per input event; it never talks to the OS directly.
//!
//! Tests at the bottom cover every transition.

use smallvec::{smallvec, SmallVec};

use super::rules::{Modifier, ResolvedAction, ResolvedRules};

/// Logical key used inside the state machine. Concrete platform keycodes are
/// translated to this enum at hook time.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub enum LogicalKey {
    CapsLock,
    Space,
    /// An uppercase ASCII character (A–Z, 0–9) — used for rule matching.
    Alpha(u8),
    /// Some other key whose specific identity doesn't matter to the state
    /// machine (arrow keys, F-keys without overrides, punctuation, etc.).
    /// The state machine treats these as generic "interruption" events.
    Other,
}

impl LogicalKey {
    /// Uppercase single-character key name, if any.
    pub fn as_char(self) -> Option<char> {
        match self {
            LogicalKey::Alpha(b) => Some(b as char),
            _ => None,
        }
    }
}

/// A synthesized key event the state machine wants the platform layer to
/// inject back into the OS.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum SyntheticEvent {
    ModifierDown(Modifier),
    ModifierUp(Modifier),
    KeyDown(SynthKey),
    KeyUp(SynthKey),
}

/// Keys that can be synthesized. Kept narrow on purpose — we only need the
/// subset the default rules touch, plus anything a user rule might
/// reference.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum SynthKey {
    Escape,
    Space,
    F4,
    /// Alphanumeric ASCII (uppercase). The synth layer maps to platform
    /// codes.
    Alpha(u8),
}

/// Final decision for a single raw event.
#[derive(Debug, PartialEq, Eq)]
pub enum Action {
    /// Let the event through unchanged.
    Forward,
    /// Swallow the event; don't emit anything.
    Suppress,
    /// Swallow the event and emit these synthetic events in order. The
    /// platform layer must tag them as "injected by us" so the hook doesn't
    /// re-enter the state machine on them.
    Emit(SmallVec<[SyntheticEvent; 6]>),
}

impl Action {
    pub fn emit(events: impl IntoIterator<Item = SyntheticEvent>) -> Self {
        Action::Emit(events.into_iter().collect())
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
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum TriggerKey {
    CapsLock,
    Space,
}

/// Stored on entry to Modifying: which modifier (if any) we already emitted
/// a *Down* for. On trigger-up we emit a matching *Up*.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum HeldModifier {
    None,
    Mod(Modifier),
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum State {
    Idle,
    /// Trigger key is physically down but no other key seen yet.
    Pending { trigger: TriggerKey },
    /// Trigger key is held and at least one other key has been processed —
    /// we're in "modifier" mode. `held` tracks whether we've injected a
    /// modifier Down whose Up we still owe the OS when the trigger releases.
    Modifying {
        trigger: TriggerKey,
        held: HeldModifier,
    },
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

    pub fn rules(&self) -> &ResolvedRules {
        &self.rules
    }

    /// Process a single raw keyboard event and return what the platform
    /// layer should do. Fast — no allocations in the hot path except the
    /// small `Emit` vector (usually stack-allocated thanks to SmallVec).
    pub fn on_event(&mut self, ev: RawEvent) -> Action {
        match (self.state, ev.kind, ev.key) {
            // ---------------- CapsLock ----------------

            // Idle + CapsLock down → enter Pending (if rule enabled).
            (State::Idle, EventKind::KeyDown, LogicalKey::CapsLock) => {
                if self.rules.capslock_to_ctrl_escape {
                    self.state = State::Pending {
                        trigger: TriggerKey::CapsLock,
                    };
                    Action::Suppress
                } else {
                    Action::Forward
                }
            }

            // Pending CapsLock + CapsLock down → autorepeat; swallow.
            (
                State::Pending {
                    trigger: TriggerKey::CapsLock,
                },
                EventKind::KeyDown,
                LogicalKey::CapsLock,
            ) => Action::Suppress,

            // Modifying with CapsLock trigger + CapsLock down → autorepeat;
            // Ctrl is already down.
            (
                State::Modifying {
                    trigger: TriggerKey::CapsLock,
                    ..
                },
                EventKind::KeyDown,
                LogicalKey::CapsLock,
            ) => Action::Suppress,

            // Pending CapsLock + another key down → enter Modifying, emit
            // Ctrl down + that key's down.
            (
                State::Pending {
                    trigger: TriggerKey::CapsLock,
                },
                EventKind::KeyDown,
                k,
            ) if is_other(k) => {
                self.state = State::Modifying {
                    trigger: TriggerKey::CapsLock,
                    held: HeldModifier::Mod(Modifier::Ctrl),
                };
                Action::emit([
                    SyntheticEvent::ModifierDown(Modifier::Ctrl),
                    SyntheticEvent::KeyDown(synth_from_logical(k)),
                ])
            }

            // Modifying with CapsLock + another key down → Ctrl is already
            // held, forward.
            (
                State::Modifying {
                    trigger: TriggerKey::CapsLock,
                    ..
                },
                EventKind::KeyDown,
                k,
            ) if is_other(k) => {
                let _ = k;
                Action::Forward
            }

            // Pending CapsLock + CapsLock up → pure tap; emit Escape press.
            (
                State::Pending {
                    trigger: TriggerKey::CapsLock,
                },
                EventKind::KeyUp,
                LogicalKey::CapsLock,
            ) => {
                self.state = State::Idle;
                Action::emit([
                    SyntheticEvent::KeyDown(SynthKey::Escape),
                    SyntheticEvent::KeyUp(SynthKey::Escape),
                ])
            }

            // Modifying CapsLock + CapsLock up → release held modifier.
            (
                State::Modifying {
                    trigger: TriggerKey::CapsLock,
                    held,
                },
                EventKind::KeyUp,
                LogicalKey::CapsLock,
            ) => {
                self.state = State::Idle;
                match held {
                    HeldModifier::Mod(m) => Action::emit([SyntheticEvent::ModifierUp(m)]),
                    HeldModifier::None => Action::Suppress,
                }
            }

            // ---------------- Space ----------------

            // Idle + Space down → enter Pending (if layer enabled).
            (State::Idle, EventKind::KeyDown, LogicalKey::Space) => {
                if self.rules.space_layer_enabled {
                    self.state = State::Pending {
                        trigger: TriggerKey::Space,
                    };
                    Action::Suppress
                } else {
                    Action::Forward
                }
            }

            (
                State::Pending {
                    trigger: TriggerKey::Space,
                },
                EventKind::KeyDown,
                LogicalKey::Space,
            ) => Action::Suppress,

            (
                State::Modifying {
                    trigger: TriggerKey::Space,
                    ..
                },
                EventKind::KeyDown,
                LogicalKey::Space,
            ) => Action::Suppress,

            // Pending Space + another key down.
            (
                State::Pending {
                    trigger: TriggerKey::Space,
                },
                EventKind::KeyDown,
                k,
            ) if is_other(k) => self.pending_space_interrupted(k),

            // Modifying with Space trigger + another key down.
            (
                State::Modifying {
                    trigger: TriggerKey::Space,
                    held,
                },
                EventKind::KeyDown,
                k,
            ) if is_other(k) => {
                // If a transparent modifier is held, forwarding the keydown
                // naturally produces mod+key. Without a transparent modifier
                // we likewise forward — the user is just typing inside the
                // layer without a handled override.
                let _ = (k, held);
                Action::Forward
            }

            // Pending Space + Space up → pure tap; emit Space press.
            (
                State::Pending {
                    trigger: TriggerKey::Space,
                },
                EventKind::KeyUp,
                LogicalKey::Space,
            ) => {
                self.state = State::Idle;
                Action::emit([
                    SyntheticEvent::KeyDown(SynthKey::Space),
                    SyntheticEvent::KeyUp(SynthKey::Space),
                ])
            }

            // Modifying Space + Space up.
            (
                State::Modifying {
                    trigger: TriggerKey::Space,
                    held,
                },
                EventKind::KeyUp,
                LogicalKey::Space,
            ) => {
                self.state = State::Idle;
                match held {
                    HeldModifier::Mod(m) => Action::emit([SyntheticEvent::ModifierUp(m)]),
                    HeldModifier::None => Action::Suppress,
                }
            }

            // ---------------- Everything else: forward ----------------
            _ => Action::Forward,
        }
    }

    fn pending_space_interrupted(&mut self, k: LogicalKey) -> Action {
        // Check for an explicit override (rule table).
        if let Some(ch) = k.as_char() {
            let token = String::from(ch);
            if let Some(action) = self.rules.space_overrides.get(&token).cloned() {
                self.state = State::Modifying {
                    trigger: TriggerKey::Space,
                    held: HeldModifier::None,
                };
                return synthesize_action(&action);
            }
        }

        // No override → apply the transparent modifier if one is configured.
        match self.rules.transparent_modifier {
            Some(m) => {
                self.state = State::Modifying {
                    trigger: TriggerKey::Space,
                    held: HeldModifier::Mod(m),
                };
                Action::emit([
                    SyntheticEvent::ModifierDown(m),
                    SyntheticEvent::KeyDown(synth_from_logical(k)),
                ])
            }
            None => {
                // No transparent modifier (Windows default). We already
                // swallowed Space-down, so we owe the user a naked keydown
                // for the key they pressed — otherwise the input is lost.
                self.state = State::Modifying {
                    trigger: TriggerKey::Space,
                    held: HeldModifier::None,
                };
                Action::emit([SyntheticEvent::KeyDown(synth_from_logical(k))])
            }
        }
    }
}

fn is_other(k: LogicalKey) -> bool {
    !matches!(k, LogicalKey::CapsLock | LogicalKey::Space)
}

fn synth_from_logical(k: LogicalKey) -> SynthKey {
    match k {
        LogicalKey::Alpha(b) => SynthKey::Alpha(b),
        _ => SynthKey::Alpha(b' '), // placeholder; callers should not hit
    }
}

fn synthesize_action(action: &ResolvedAction) -> Action {
    // Emit: all modifiers down (in order), key down, key up, modifiers up
    // (in reverse order).
    // Named-key lookup runs first so multi-char tokens like "F4", "ESC",
    // "SPACE" don't get misread as their first-byte ASCII letter.
    let key = match action.key.as_str() {
        "ESC" | "ESCAPE" => SynthKey::Escape,
        "SPACE" => SynthKey::Space,
        "F4" => SynthKey::F4,
        s if s.len() == 1 => {
            let b = s.as_bytes()[0];
            if b.is_ascii_uppercase() || b.is_ascii_digit() {
                SynthKey::Alpha(b)
            } else {
                SynthKey::Alpha(b' ')
            }
        }
        _ => SynthKey::Alpha(b' '),
    };
    let mut events: SmallVec<[SyntheticEvent; 6]> = smallvec![];
    for m in action.modifiers.iter() {
        events.push(SyntheticEvent::ModifierDown(*m));
    }
    events.push(SyntheticEvent::KeyDown(key));
    events.push(SyntheticEvent::KeyUp(key));
    for m in action.modifiers.iter().rev() {
        events.push(SyntheticEvent::ModifierUp(*m));
    }
    Action::Emit(events)
}

// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;
    use crate::remap::rules::ResolvedRules;
    use smallvec::SmallVec;
    use std::collections::HashMap;

    fn rules_mac() -> ResolvedRules {
        let mut overrides = HashMap::new();
        overrides.insert(
            "W".to_string(),
            ResolvedAction {
                modifiers: {
                    let mut m: SmallVec<[Modifier; 4]> = SmallVec::new();
                    m.push(Modifier::Ctrl);
                    m.push(Modifier::Alt);
                    m
                },
                key: "W".to_string(),
            },
        );
        ResolvedRules {
            capslock_to_ctrl_escape: true,
            space_layer_enabled: true,
            transparent_modifier: Some(Modifier::Cmd),
            space_overrides: overrides,
        }
    }

    fn rules_win() -> ResolvedRules {
        let mut overrides = HashMap::new();
        overrides.insert(
            "W".to_string(),
            ResolvedAction {
                modifiers: {
                    let mut m: SmallVec<[Modifier; 4]> = SmallVec::new();
                    m.push(Modifier::Ctrl);
                    m.push(Modifier::Alt);
                    m
                },
                key: "W".to_string(),
            },
        );
        overrides.insert(
            "Q".to_string(),
            ResolvedAction {
                modifiers: {
                    let mut m: SmallVec<[Modifier; 4]> = SmallVec::new();
                    m.push(Modifier::Alt);
                    m
                },
                key: "F4".to_string(),
            },
        );
        ResolvedRules {
            capslock_to_ctrl_escape: true,
            space_layer_enabled: true,
            transparent_modifier: None,
            space_overrides: overrides,
        }
    }

    fn down(k: LogicalKey) -> RawEvent {
        RawEvent {
            kind: EventKind::KeyDown,
            key: k,
        }
    }
    fn up(k: LogicalKey) -> RawEvent {
        RawEvent {
            kind: EventKind::KeyUp,
            key: k,
        }
    }

    #[test]
    fn capslock_tap_emits_escape() {
        let mut sm = StateMachine::new(rules_mac());
        assert_eq!(sm.on_event(down(LogicalKey::CapsLock)), Action::Suppress);
        assert_eq!(
            sm.on_event(up(LogicalKey::CapsLock)),
            Action::emit([
                SyntheticEvent::KeyDown(SynthKey::Escape),
                SyntheticEvent::KeyUp(SynthKey::Escape),
            ])
        );
    }

    #[test]
    fn capslock_hold_plus_c_becomes_ctrl_c() {
        let mut sm = StateMachine::new(rules_mac());
        sm.on_event(down(LogicalKey::CapsLock));
        assert_eq!(
            sm.on_event(down(LogicalKey::Alpha(b'C'))),
            Action::emit([
                SyntheticEvent::ModifierDown(Modifier::Ctrl),
                SyntheticEvent::KeyDown(SynthKey::Alpha(b'C')),
            ])
        );
        // Second key while Ctrl still held → Forward.
        assert_eq!(
            sm.on_event(down(LogicalKey::Alpha(b'V'))),
            Action::Forward
        );
        assert_eq!(
            sm.on_event(up(LogicalKey::CapsLock)),
            Action::emit([SyntheticEvent::ModifierUp(Modifier::Ctrl)])
        );
    }

    #[test]
    fn capslock_repeat_is_suppressed() {
        let mut sm = StateMachine::new(rules_mac());
        sm.on_event(down(LogicalKey::CapsLock));
        assert_eq!(sm.on_event(down(LogicalKey::CapsLock)), Action::Suppress);
    }

    #[test]
    fn space_tap_emits_space() {
        let mut sm = StateMachine::new(rules_mac());
        assert_eq!(sm.on_event(down(LogicalKey::Space)), Action::Suppress);
        assert_eq!(
            sm.on_event(up(LogicalKey::Space)),
            Action::emit([
                SyntheticEvent::KeyDown(SynthKey::Space),
                SyntheticEvent::KeyUp(SynthKey::Space),
            ])
        );
    }

    #[test]
    fn space_plus_c_on_mac_is_transparent_cmd_c() {
        let mut sm = StateMachine::new(rules_mac());
        sm.on_event(down(LogicalKey::Space));
        assert_eq!(
            sm.on_event(down(LogicalKey::Alpha(b'C'))),
            Action::emit([
                SyntheticEvent::ModifierDown(Modifier::Cmd),
                SyntheticEvent::KeyDown(SynthKey::Alpha(b'C')),
            ])
        );
        assert_eq!(
            sm.on_event(up(LogicalKey::Space)),
            Action::emit([SyntheticEvent::ModifierUp(Modifier::Cmd)])
        );
    }

    #[test]
    fn space_plus_w_fires_override_no_transparent_cmd() {
        let mut sm = StateMachine::new(rules_mac());
        sm.on_event(down(LogicalKey::Space));
        let action = sm.on_event(down(LogicalKey::Alpha(b'W')));
        assert_eq!(
            action,
            Action::emit([
                SyntheticEvent::ModifierDown(Modifier::Ctrl),
                SyntheticEvent::ModifierDown(Modifier::Alt),
                SyntheticEvent::KeyDown(SynthKey::Alpha(b'W')),
                SyntheticEvent::KeyUp(SynthKey::Alpha(b'W')),
                SyntheticEvent::ModifierUp(Modifier::Alt),
                SyntheticEvent::ModifierUp(Modifier::Ctrl),
            ])
        );
        // Space-up after override-triggered Modifying should NOT emit Cmd up.
        assert_eq!(sm.on_event(up(LogicalKey::Space)), Action::Suppress);
    }

    #[test]
    fn space_plus_q_on_windows_synthesizes_alt_f4() {
        let mut sm = StateMachine::new(rules_win());
        sm.on_event(down(LogicalKey::Space));
        assert_eq!(
            sm.on_event(down(LogicalKey::Alpha(b'Q'))),
            Action::emit([
                SyntheticEvent::ModifierDown(Modifier::Alt),
                SyntheticEvent::KeyDown(SynthKey::F4),
                SyntheticEvent::KeyUp(SynthKey::F4),
                SyntheticEvent::ModifierUp(Modifier::Alt),
            ])
        );
        assert_eq!(sm.on_event(up(LogicalKey::Space)), Action::Suppress);
    }

    #[test]
    fn space_plus_unhandled_key_on_windows_emits_naked_keydown() {
        let mut sm = StateMachine::new(rules_win());
        sm.on_event(down(LogicalKey::Space));
        // "Z" has no rule on Windows and there's no transparent modifier.
        assert_eq!(
            sm.on_event(down(LogicalKey::Alpha(b'Z'))),
            Action::emit([SyntheticEvent::KeyDown(SynthKey::Alpha(b'Z'))])
        );
    }

    #[test]
    fn space_disabled_passes_through() {
        let mut rules = rules_mac();
        rules.space_layer_enabled = false;
        let mut sm = StateMachine::new(rules);
        assert_eq!(sm.on_event(down(LogicalKey::Space)), Action::Forward);
    }

    #[test]
    fn capslock_disabled_passes_through() {
        let mut rules = rules_mac();
        rules.capslock_to_ctrl_escape = false;
        let mut sm = StateMachine::new(rules);
        assert_eq!(sm.on_event(down(LogicalKey::CapsLock)), Action::Forward);
    }

    #[test]
    fn other_keys_forward_when_idle() {
        let mut sm = StateMachine::new(rules_mac());
        assert_eq!(
            sm.on_event(down(LogicalKey::Alpha(b'A'))),
            Action::Forward
        );
        assert_eq!(sm.on_event(up(LogicalKey::Alpha(b'A'))), Action::Forward);
    }
}
