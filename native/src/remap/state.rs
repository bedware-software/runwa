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
    /// Inject synthetic events, then forward the original with the given
    /// modifier flag stamped on top of the original's existing flag state.
    /// Used by the transparent-modifier and fallback-modifier interruption
    /// paths when the layered key IS one we could synthesize — but doing so
    /// makes the macOS app-switcher (and similar system services that
    /// filter `EVENT_SOURCE_USER_DATA`-tagged events) see no real
    /// keystroke. Forwarding the user's actual `Tab` event makes Space+Tab
    /// behave like Cmd+Tab: a tap moves the switcher one slot, holding
    /// Tab autorepeats it via the keyboard hardware (still flowing through
    /// `ForwardWithModifier` for repeat events). On Windows `SendInput`
    /// already propagates the modifier flag globally so per-event
    /// stamping is a no-op there — the platform layer just forwards.
    EmitThenForwardWithModifier(SmallVec<[SyntheticEvent; 8]>, Modifier),
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

    pub fn emit_then_forward_with_modifier(
        events: impl IntoIterator<Item = SyntheticEvent>,
        modifier: Modifier,
    ) -> Self {
        Action::EmitThenForwardWithModifier(events.into_iter().collect(), modifier)
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

            // Idle + trigger-down: enter Pending — UNLESS an external
            // (non-self) modifier is already held, in which case the user
            // is reaching for an OS-level chord (Cmd+Space → Spotlight,
            // Cmd+Tab → app switcher, Shift+Tab → reverse focus, Win+L,
            // Alt+Space, …). Forward the keydown so the chord reaches
            // the OS / app instead of being swallowed into our trigger
            // layer. Pre-emption of an already-Pending modifier trigger
            // (Shift-then-Space-then-N) is handled by the dedicated arm
            // below; that path runs from Pending, not Idle, so this
            // guard doesn't interfere with it.
            (State::Idle, EventKind::KeyDown, Some(t), Some(_)) => {
                let mut external = ev.modifiers;
                if let Some(self_mod) = key_self_modifier(t) {
                    external.remove(self_mod);
                }
                if !external.is_empty() {
                    Action::Forward
                } else {
                    self.state = State::Pending { trigger: t };
                    Action::Suppress
                }
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

            // Non-modifier trigger preempts a modifier trigger in Pending —
            // but only when the new trigger's on_hold has rules that use
            // the held modifier.
            //
            // Example (preempt fires): user holds Shift (a configured
            // trigger) and then presses Space (also a trigger) whose
            // on_hold has a `keys: [shift, 1]` rule. Intent is to use
            // Space's layer with Shift as a physical modifier, NOT
            // Shift's tap or transparent-modifier-layer. Switch the
            // primary trigger to Space and let its rules fire on
            // subsequent keys — the ModifierMask snapshot carries Shift
            // on those events via GetAsyncKeyState (Windows) /
            // CGEventFlags (macOS), so `keys: [shift, n]` matches
            // regardless of press order.
            //
            // Counter-example (preempt does NOT fire, falls through to
            // the interruption arm below): user holds Shift and presses
            // Tab. Tab is a trigger with `on_tap: [tab]` and an on_hold
            // whose rules don't use Shift as a modifier. The user's
            // intent is the OS Shift+Tab chord, not Tab's tap. Without
            // the `uses_modifier` guard, the preempt arm switches state
            // to Pending(Tab) and Tab-up emits Tab's on_tap — the user
            // gets plain Tab on the first press (the "first time"
            // weirdness reported users see, after which Shift is still
            // held and a second press lands at Idle and forwards
            // correctly).
            (State::Pending { trigger: ts }, EventKind::KeyDown, Some(te), Some(b))
                if ts != te
                    && ts.is_modifier()
                    && !te.is_modifier()
                    && key_self_modifier(ts).is_some_and(|m| b.uses_modifier(m)) =>
            {
                self.state = State::Pending { trigger: te };
                Action::Suppress
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
                // Inject the modifier-down only and forward the user's
                // real KeyDown with the modifier flag stamped. Synthesizing
                // a paired Key↓/Key↑ via `Action::Emit` works for ordinary
                // apps but breaks under the macOS app switcher: switcher
                // input handling filters our `EVENT_SOURCE_USER_DATA`-
                // tagged events, so it sees Tab↓ but never Tab↑, then
                // autoradoresses through every app. Forwarding the user's
                // real Tab leaves the keystroke source untouched and the
                // switcher behaves correctly. Same path covers unrecognized
                // keys (LogicalKey::Other / non-Named) — there's no
                // physical keycode we'd synthesize in that case anyway.
                Action::emit_then_forward_with_modifier(
                    [SyntheticEvent::ModifierDown(m)],
                    m,
                )
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
                // Inject the modifier-down only and forward the user's
                // real keystroke with the flag stamped — see the
                // TransparentModifier comment above for the macOS-app-
                // -switcher rationale (synth events get filtered by the
                // switcher's input handling, so Space+Tab needs a real
                // Tab to flow through, not a synthesized one).
                if let Some(m) = *fallback {
                    self.state = State::Modifying { trigger, held: Some(m) };
                    return Action::emit_then_forward_with_modifier(
                        [SyntheticEvent::ModifierDown(m)],
                        m,
                    );
                }

                // No override, no fallback → forward the naked key
                // unchanged. State stays in `held: None` so the next
                // press of any other key re-fires the override path.
                self.state = State::Modifying { trigger, held: None };
                Action::Forward
            }
        }
    }
}

/// Map a logical-key trigger to the modifier bit it sets in its OWN keydown
/// event. Used to distinguish "self-modifier flag set because the trigger is
/// what just went down" from "external modifier held" when deciding whether
/// a trigger-down from Idle should start a layer or pass through as part of
/// an OS chord.
fn key_self_modifier(k: LogicalKey) -> Option<Modifier> {
    match k {
        LogicalKey::Shift => Some(Modifier::Shift),
        LogicalKey::Ctrl => Some(Modifier::Ctrl),
        LogicalKey::Alt => Some(Modifier::Alt),
        LogicalKey::Cmd => Some(Modifier::Cmd),
        _ => None,
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
        // The transparent-modifier path injects ModifierDown only and
        // forwards the user's real KeyDown with the modifier flag stamped.
        // See the TransparentModifier arm in `handle_interruption` for the
        // Space+Tab case that motivated this.
        assert_eq!(
            m.on_event(down(alpha('C'))),
            Action::EmitThenForwardWithModifier(
                smallvec::smallvec![SyntheticEvent::ModifierDown(Modifier::Ctrl)],
                Modifier::Ctrl,
            )
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
        // Fallback path injects ModifierDown only and forwards the user's
        // real KeyDown with the modifier flag stamped, same as
        // TransparentModifier — see the comment in `handle_interruption`.
        assert_eq!(
            m.on_event(down(alpha('C'))),
            Action::EmitThenForwardWithModifier(
                smallvec::smallvec![SyntheticEvent::ModifierDown(Modifier::Cmd)],
                Modifier::Cmd,
            )
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
        // No override and no fallback: just forward the user's real key
        // unchanged (state moves to Modifying { held: None } so the next
        // press of any other key re-runs handle_interruption).
        assert_eq!(m.on_event(down(alpha('Z'))), Action::Forward);
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

    // Reproduces the user-reported "Space+Tab cycles through every running
    // app on a single tap, and the next tap doesn't work" bug. Default
    // macOS template has Space's on_hold ending in `keys: [any],
    // to_hotkey: [cmd]`, so Space+Tab routes through the fallback. Two
    // earlier fix attempts didn't work:
    //
    //   1. Synth `[Cmd↓, Tab↓]` — Tab↑ never emitted, macOS believed Tab
    //      was held, app switcher autorepeated through every app.
    //   2. Synth `[Cmd↓, Tab↓, Tab↑]` — same symptom, because the macOS
    //      app switcher's input handling appears to filter our
    //      EVENT_SOURCE_USER_DATA-tagged events. The synth Tab↑ never
    //      reaches the switcher; from its perspective Tab is still held.
    //
    // The fix injects ONLY the modifier-down (so the user's apps see the
    // Cmd flag stamp) and forwards the user's REAL Tab↓ with the Cmd flag
    // stamped on top. The switcher receives a real keystroke (no inject
    // tag, real source PID) it can't filter, and behaves correctly: tap
    // moves one slot, hold autorepeats via the keyboard hardware.
    #[test]
    fn space_plus_tab_fallback_forwards_real_tab_with_modifier_stamped() {
        let yaml = r#"
tab:
  on_tap: [tab]
  on_hold:
    - { keys: [j], to_hotkey: [ctrl, tab] }
space:
  on_tap: [space]
  on_hold:
    - { keys: [any], to_hotkey: [cmd] }
"#;
        let mut m = sm(yaml);
        m.on_event(down(LogicalKey::Space));
        // First Tab tap: inject Cmd↓, forward the real Tab↓ with Cmd
        // stamped.
        assert_eq!(
            m.on_event(down(named(NamedKey::Tab))),
            Action::EmitThenForwardWithModifier(
                smallvec::smallvec![SyntheticEvent::ModifierDown(Modifier::Cmd)],
                Modifier::Cmd,
            )
        );
        // Tab released: forward the real Tab↑ with Cmd stamped — switcher
        // sees a real release, no synth state to confuse it.
        assert_eq!(
            m.on_event(up(named(NamedKey::Tab))),
            Action::ForwardWithModifier(Modifier::Cmd)
        );
        // Second physical tap inside the same Space-hold: forward path
        // again. Cmd stays continuously held via the trigger, switcher
        // stays open, advances one slot per tap (matches native Cmd+Tab).
        assert_eq!(
            m.on_event(down(named(NamedKey::Tab))),
            Action::ForwardWithModifier(Modifier::Cmd)
        );
        assert_eq!(
            m.on_event(up(named(NamedKey::Tab))),
            Action::ForwardWithModifier(Modifier::Cmd)
        );
        // Releasing Space emits ModifierUp(Cmd) — closes the switcher,
        // selected app activates.
        assert_eq!(
            m.on_event(up(LogicalKey::Space)),
            emit(vec![SyntheticEvent::ModifierUp(Modifier::Cmd)])
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

        // Hold path — Shift+L. Inject ModifierDown only, forward the
        // user's real L↓ with Shift stamped.
        m.on_event(down(LogicalKey::Shift));
        assert_eq!(
            m.on_event(down(alpha('L'))),
            Action::EmitThenForwardWithModifier(
                smallvec::smallvec![SyntheticEvent::ModifierDown(Modifier::Shift)],
                Modifier::Shift,
            )
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
    fn modifier_trigger_preempted_by_nonmodifier_trigger() {
        // Shift is a trigger (its tap emits Cmd+Space); Space is also a
        // trigger with a modifier-qualified rule. Press order Shift → Space
        // → 1 should fire Space's `[shift, 1]` override the same way the
        // natural order Space → Shift → 1 does. Without the pre-emption
        // arm, Shift's transparent-Shift layer wins and 1 emits Shift+1.
        let yaml = r#"
shift:
  on_tap: [cmd, space]
space:
  on_tap: [space]
  on_hold:
    - keys: [shift, 1]
      move_to_workspace: 1
"#;
        let mut m = sm(yaml);

        // Shift first — enters Pending(Shift).
        assert_eq!(m.on_event(down(LogicalKey::Shift)), Action::Suppress);

        // Space second — pre-empts Shift, enters Pending(Space). Shift's
        // tap is abandoned; the physical Shift is still held in hardware
        // and will show up on the subsequent 1 keydown's mods mask.
        assert_eq!(m.on_event(down(LogicalKey::Space)), Action::Suppress);

        // 1 with Shift held — Space's qualified rule fires.
        let mut shift = ModifierMask::EMPTY;
        shift.insert(Modifier::Shift);
        assert_eq!(
            m.on_event(down_with_mods(alpha('1'), shift)),
            emit(vec![SyntheticEvent::MoveToWorkspace(1)])
        );
    }

    // External modifier held when trigger-down arrives → forward, so OS
    // chords like Cmd+Space (Spotlight), Cmd+Tab (app switcher) and
    // Shift+Tab (reverse focus traversal) keep working even when the
    // user has bound the trigger key.
    #[test]
    fn cmd_held_then_space_forwards_for_os_chord() {
        let mut m = sm(SPACE_MAC);
        let mut cmd = ModifierMask::EMPTY;
        cmd.insert(Modifier::Cmd);
        assert_eq!(
            m.on_event(down_with_mods(LogicalKey::Space, cmd)),
            Action::Forward
        );
        // Trigger-up from Idle (we never entered Pending) is also forwarded.
        let space_up_with_cmd = RawEvent {
            kind: EventKind::KeyUp,
            key: LogicalKey::Space,
            modifiers: cmd,
        };
        assert_eq!(m.on_event(space_up_with_cmd), Action::Forward);
    }

    #[test]
    fn shift_held_then_tab_forwards_for_reverse_focus() {
        let yaml = r#"
tab:
  on_tap: [tab]
  on_hold:
    - { keys: [j], to_hotkey: [ctrl, tab] }
"#;
        let mut m = sm(yaml);
        let mut shift = ModifierMask::EMPTY;
        shift.insert(Modifier::Shift);
        assert_eq!(
            m.on_event(down_with_mods(named(NamedKey::Tab), shift)),
            Action::Forward
        );
    }

    // Real-config variant: Shift is also a configured trigger, so the
    // user's first Shift+Tab arrives in Pending(Shift) rather than Idle.
    // The preempt-from-Pending arm used to unconditionally switch into
    // Pending(Tab), and Tab-up then emitted Tab's `on_tap` — the user
    // got plain Tab on the first press while Shift was held, then
    // correct Shift+Tab on subsequent presses (because the second press
    // arrives at Idle, where the external-modifier guard forwards).
    //
    // Tab's on_hold here doesn't use Shift in any rule, so the new
    // `uses_modifier` guard rejects the preempt and the interruption
    // arm runs Shift's TransparentModifier(Shift) layer instead — which
    // forwards the chord by emitting ModifierDown(Shift) + KeyDown(Tab).
    #[test]
    fn shift_pending_then_tab_emits_shift_tab_via_transparent_layer() {
        let yaml = r#"
shift:
  on_tap: [escape]

tab:
  on_tap: [tab]
  on_hold:
    - { keys: [j], to_hotkey: [ctrl, tab] }
    - { keys: [k], to_hotkey: [ctrl, shift, tab] }
"#;
        let mut m = sm(yaml);

        // Shift first — own keydown has Shift's self-flag set on real
        // platforms, but state machine doesn't care; enter Pending(Shift).
        assert_eq!(m.on_event(down(LogicalKey::Shift)), Action::Suppress);

        // Tab arrives with Shift held in the modifier mask. Tab's
        // on_hold rules use only `j` and `k` (no shift-qualified rules),
        // so the preempt guard rejects switching into Pending(Tab).
        // Falls through to the interruption arm: Shift's transparent
        // layer fires — inject ModifierDown(Shift) and forward the
        // user's real Tab↓ with the Shift flag stamped, so any system
        // service that filters synthetic events still sees a real Tab.
        let mut shift = ModifierMask::EMPTY;
        shift.insert(Modifier::Shift);
        assert_eq!(
            m.on_event(down_with_mods(named(NamedKey::Tab), shift)),
            Action::EmitThenForwardWithModifier(
                smallvec::smallvec![SyntheticEvent::ModifierDown(Modifier::Shift)],
                Modifier::Shift,
            )
        );
    }

    // Counter-case: when the new trigger's on_hold DOES use the held
    // modifier, the preempt arm still fires. Same setup as
    // `modifier_trigger_preempted_by_nonmodifier_trigger` plus the
    // realistic Shift-self flag on the Space-down — guards against
    // accidentally regressing the [shift, 1] preempt path while
    // tightening the guard for the Tab path above.
    #[test]
    fn shift_pending_then_space_with_shift_rule_still_preempts() {
        let yaml = r#"
shift:
  on_tap: [escape]
space:
  on_tap: [space]
  on_hold:
    - keys: [shift, 1]
      move_to_workspace: 1
"#;
        let mut m = sm(yaml);
        assert_eq!(m.on_event(down(LogicalKey::Shift)), Action::Suppress);

        let mut shift = ModifierMask::EMPTY;
        shift.insert(Modifier::Shift);
        // Space has a `keys: [shift, 1]` override — preempt arm fires,
        // state becomes Pending(Space).
        assert_eq!(
            m.on_event(down_with_mods(LogicalKey::Space, shift)),
            Action::Suppress
        );
    }

    #[test]
    fn cmd_held_then_modifier_trigger_forwards() {
        // shift is configured as a tap-trigger. Pressing Cmd+Shift should
        // forward Shift-down (the keydown carries both Cmd and Shift bits)
        // — without the self-vs-external distinction we'd subtract nothing,
        // see the Cmd flag, and forward; but if we naively subtracted ALL
        // mods we'd see empty and enter Pending(Shift), then on Shift-up
        // emit the on_tap and lose the Cmd+Shift chord entirely.
        let yaml = r#"
shift:
  on_tap: [escape]
"#;
        let mut m = sm(yaml);
        let mut both = ModifierMask::EMPTY;
        both.insert(Modifier::Cmd);
        both.insert(Modifier::Shift); // self-flag is set on Shift's own keydown
        assert_eq!(
            m.on_event(down_with_mods(LogicalKey::Shift, both)),
            Action::Forward
        );
    }

    #[test]
    fn modifier_trigger_alone_with_self_flag_still_pendings() {
        // Real platform delivers Shift's own keydown with the Shift flag
        // already set. The self-flag must not look like an external
        // modifier — Shift-tap-for-Esc has to keep working.
        let yaml = r#"
shift:
  on_tap: [escape]
"#;
        let mut m = sm(yaml);
        let mut shift_self = ModifierMask::EMPTY;
        shift_self.insert(Modifier::Shift);
        assert_eq!(
            m.on_event(down_with_mods(LogicalKey::Shift, shift_self)),
            Action::Suppress
        );
        assert_eq!(
            m.on_event(up(LogicalKey::Shift)),
            emit_tap(vec![
                SyntheticEvent::KeyDown(NamedKey::Escape),
                SyntheticEvent::KeyUp(NamedKey::Escape),
            ])
        );
    }

    #[test]
    fn shift_pending_then_space_with_shift_flag_still_preempts() {
        // Real-platform variant of `modifier_trigger_preempted_by_nonmodifier_trigger`:
        // when Space arrives during Pending(Shift), the Space-down carries
        // Shift's flag. The new "external mod → forward" guard runs only
        // from Idle, so the preempt arm (which fires from Pending) still
        // wins and the user gets Space's [shift,1] override.
        let yaml = r#"
shift:
  on_tap: [cmd, space]
space:
  on_tap: [space]
  on_hold:
    - keys: [shift, 1]
      move_to_workspace: 1
"#;
        let mut m = sm(yaml);
        m.on_event(down(LogicalKey::Shift));

        let mut shift = ModifierMask::EMPTY;
        shift.insert(Modifier::Shift);
        // Space-down with Shift flag set — preempt arm fires from Pending(Shift).
        assert_eq!(
            m.on_event(down_with_mods(LogicalKey::Space, shift)),
            Action::Suppress
        );
        assert_eq!(
            m.on_event(down_with_mods(alpha('1'), shift)),
            emit(vec![SyntheticEvent::MoveToWorkspace(1)])
        );
    }

    #[test]
    fn capslock_plus_other_key_emits_ctrl_then_forwards() {
        // Ctrl+F13 (or any other unmapped non-Named key): we can't synth
        // the keystroke, so press Ctrl and let the OS see the original.
        // Same `EmitThenForwardWithModifier` path the Named-key case uses,
        // since the platform layer also stamps the modifier flag on the
        // forwarded event for keys we couldn't synthesize either way.
        let mut m = sm(CAPS_CTRL_ESC);
        m.on_event(down(LogicalKey::CapsLock));
        match m.on_event(down(LogicalKey::Other)) {
            Action::EmitThenForwardWithModifier(evs, Modifier::Ctrl) => {
                assert_eq!(
                    evs.as_slice(),
                    &[SyntheticEvent::ModifierDown(Modifier::Ctrl)]
                );
            }
            other => panic!("expected EmitThenForwardWithModifier(.., Ctrl), got {other:?}"),
        }
        assert_eq!(
            m.on_event(up(LogicalKey::CapsLock)),
            emit(vec![SyntheticEvent::ModifierUp(Modifier::Ctrl)])
        );
    }

    // Reported user bug: with `shift: { on_tap: [cmd, space] }`, holding
    // Shift and clicking the mouse and then releasing Shift was firing
    // Cmd+Space — Spotlight/the palette popped up after every Shift+click.
    // The macOS platform layer surfaces mouse-downs as `LogicalKey::Other`
    // KeyDown events, which interrupts Pending(Shift): Shift's transparent
    // layer fires (so the click is forwarded with the Shift flag stamped)
    // and Shift-up emits ModifierUp instead of the on_tap.
    #[test]
    fn shift_pending_then_mouse_click_does_not_fire_on_tap() {
        let yaml = r#"
shift:
  on_tap: [cmd, space]
"#;
        let mut m = sm(yaml);
        assert_eq!(m.on_event(down(LogicalKey::Shift)), Action::Suppress);
        assert_eq!(
            m.on_event(down(LogicalKey::Other)),
            Action::EmitThenForwardWithModifier(
                smallvec::smallvec![SyntheticEvent::ModifierDown(Modifier::Shift)],
                Modifier::Shift,
            )
        );
        assert_eq!(
            m.on_event(up(LogicalKey::Shift)),
            emit(vec![SyntheticEvent::ModifierUp(Modifier::Shift)])
        );
    }
}
