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
    Modifier, ModifierMask, ModifierSide, NamedKey, ResolvedBinding, ResolvedHold, ResolvedRules,
    SyntheticEvent,
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
    LeftShift,
    RightShift,
    Ctrl,
    LeftCtrl,
    RightCtrl,
    Alt,
    LeftAlt,
    RightAlt,
    /// Cmd on macOS, Win on Windows — they're the same logical key.
    Cmd,
    LeftCmd,
    RightCmd,
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
        matches!(
            self,
            LogicalKey::Shift
                | LogicalKey::LeftShift
                | LogicalKey::RightShift
                | LogicalKey::Ctrl
                | LogicalKey::LeftCtrl
                | LogicalKey::RightCtrl
                | LogicalKey::Alt
                | LogicalKey::LeftAlt
                | LogicalKey::RightAlt
                | LogicalKey::Cmd
                | LogicalKey::LeftCmd
                | LogicalKey::RightCmd
        )
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
    /// modifiers stamped on top of the original's existing flag state.
    /// Used by the transparent-modifier and fallback-modifier interruption
    /// paths when the layered key IS one we could synthesize — but doing so
    /// makes the macOS app-switcher (and similar system services that
    /// filter `EVENT_SOURCE_USER_DATA`-tagged events) see no real
    /// keystroke. Forwarding the user's actual `Tab` event makes Space+Tab
    /// behave like Cmd+Tab: a tap moves the switcher one slot, holding
    /// Tab autorepeats it via the keyboard hardware (still flowing through
    /// `ForwardWithModifiers` for repeat events). The mask may carry more
    /// than one modifier for multi-modifier fallbacks (`[any] → [ctrl,
    /// shift]`). On Windows `SendInput` already propagates the modifier
    /// flags globally so per-event stamping is a no-op there — the platform
    /// layer just forwards.
    EmitThenForwardWithModifiers(SmallVec<[SyntheticEvent; 8]>, ModifierMask),
    /// Forward the event but assert the given modifiers on it. Used when a
    /// transparent modifier — or a multi-modifier fallback layer — is
    /// logically held (state is `Modifying{held}` with a non-empty mask)
    /// and a subsequent real key event arrives. Platform layers stamp the
    /// modifiers onto the event before letting it through. On Windows this
    /// is equivalent to `Forward` because `SendInput` already updated the
    /// global key state; on macOS, CGEvent posting doesn't propagate
    /// synthetic modifier-down state to real subsequent events, so the
    /// platform layer has to set the flags explicitly.
    ForwardWithModifiers(ModifierMask),
}

impl Action {
    pub fn emit(events: impl IntoIterator<Item = SyntheticEvent>) -> Self {
        Action::Emit(events.into_iter().collect())
    }

    pub fn emit_tap(events: impl IntoIterator<Item = SyntheticEvent>) -> Self {
        Action::EmitTap(events.into_iter().collect())
    }

    pub fn emit_then_forward_with_modifiers(
        events: impl IntoIterator<Item = SyntheticEvent>,
        modifiers: ModifierMask,
    ) -> Self {
        Action::EmitThenForwardWithModifiers(events.into_iter().collect(), modifiers)
    }

    /// Like `emit`, but collapses an empty sequence to `Suppress`. Emitting
    /// zero events injects nothing yet still reports "handled", so the
    /// dedicated variant reads more honestly. Used when tearing down a
    /// `Comboing` chord whose release sequence may be empty — a workspace
    /// switch enters the held path purely to fire once, with nothing to undo
    /// on key-up.
    pub fn emit_or_suppress(events: impl IntoIterator<Item = SyntheticEvent>) -> Self {
        let events: SmallVec<[SyntheticEvent; 8]> = events.into_iter().collect();
        if events.is_empty() {
            Action::Suppress
        } else {
            Action::Emit(events)
        }
    }
}

// ---------------------------------------------------------------------------

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum State {
    Idle,
    /// Trigger is physically down, nothing else has been seen yet.
    /// `suppress_tap` is set when the trigger was pressed while an
    /// external modifier was already held AND the trigger's on_hold
    /// is `TransparentModifier`. In that case the user's intent is
    /// to combine modifiers for a chord (e.g. Shift held, then
    /// CapsLock-as-Ctrl → user wants Ctrl+Shift+<next>), not to
    /// emit the trigger's on_tap. If the user releases the trigger
    /// without an interruption, we still want to swallow the press
    /// silently rather than fire the tap (e.g. CapsLock's on_tap is
    /// Escape — Shift+CapsLock by itself shouldn't ghost-emit
    /// Shift+Escape).
    Pending {
        trigger: LogicalKey,
        suppress_tap: bool,
    },
    /// Trigger is held and we've processed at least one other key. `held`
    /// tracks the modifiers we've injected downs for but haven't released
    /// yet (we emit the matching ups on trigger release). An empty mask
    /// means nothing is outstanding. Usually zero or one modifier; a
    /// multi-modifier fallback (`[any] → [ctrl, shift]`) fills it with more.
    Modifying {
        trigger: LogicalKey,
        held: ModifierMask,
    },
    /// A modifier-chord on_hold combo just fired and is "physically
    /// held" via our synthesized modifier-down events. We're waiting
    /// for either the combo key or the trigger to come back up; on
    /// either, we emit the matching release sequence stashed in
    /// `StateMachine::combo_release`. Autorepeat KeyDowns of the
    /// combo key while in this state are suppressed — chord
    /// modifiers are already down, no need to re-emit. This is what
    /// turns `Space+D → Ctrl+Alt+Cmd+D` from a microsecond tap into
    /// a real hold-to-talk binding.
    Comboing {
        trigger: LogicalKey,
        combo_key: NamedKey,
    },
    /// A transparent-modifier trigger (Shift, CapsLock-as-Ctrl, …) is
    /// physically held: we injected its `ModifierDown` the instant the
    /// trigger went down, so the modifier is genuinely active for mouse
    /// clicks and any subsequent key — `Shift+Click` and `Ctrl+Click`
    /// work from the moment of press, not only after a keyboard
    /// interruption. A tap is still possible: if the trigger comes back
    /// up with nothing in between, we release the modifier and fire the
    /// trigger's `on_tap`. The first interruption (a non-trigger key, or
    /// a mouse button via [`StateMachine::on_pointer_down`]) promotes us
    /// to `Modifying { held: Some(m) }`, which cancels the tap and owns
    /// the modifier-up on trigger release.
    EagerModifier {
        trigger: LogicalKey,
        modifier: Modifier,
    },
}

pub struct StateMachine {
    rules: ResolvedRules,
    state: State,
    /// Release-side events for the currently-active push-to-talk
    /// chord. `Some(_)` iff `state == State::Comboing { .. }`.
    /// Drained when the combo key or trigger comes back up. Holding
    /// this on the machine (rather than inside the State variant)
    /// keeps `State` `Copy`, which the `match (self.state, …)`
    /// dispatch elsewhere depends on.
    combo_release: Option<SmallVec<[SyntheticEvent; 4]>>,
}

impl StateMachine {
    pub fn new(rules: ResolvedRules) -> Self {
        Self {
            rules,
            state: State::Idle,
            combo_release: None,
        }
    }

    fn binding_for(&self, key: LogicalKey) -> Option<ResolvedBinding> {
        self.rules
            .triggers
            .get(&key)
            .or_else(|| {
                generic_modifier_key(key).and_then(|generic| self.rules.triggers.get(&generic))
            })
            .cloned()
    }

    pub fn on_event(&mut self, ev: RawEvent) -> Action {
        // Does this key itself have a rule? Treat it as a trigger candidate
        // if it does.
        let binding = self.binding_for(ev.key);

        // Modifier keys (Shift/Ctrl/Alt/Cmd) that aren't the trigger of an
        // already-active layer should never interrupt or consume that
        // layer. Example: while Space is Pending, a physical Shift-down
        // must pass through so the user can type Space+Shift+, to get
        // Shift+Home. Modifiers DO act as triggers themselves, but only
        // when they're pressed from Idle — once another trigger has the
        // layer, modifiers are transparent.
        //
        // Subtle: when we're in `Modifying { held: Some(m) }` — i.e.
        // an active fallback-modifier or transparent-modifier layer
        // is asserting `m` (typically Cmd, e.g. Space+Tab keeping the
        // macOS app switcher open) — the real modifier event must
        // carry our held flag forward, otherwise macOS' modifier-
        // state reconciliation on the real event can drop the synth-
        // asserted bit and close the switcher / break the chord
        // (user-visible as "pressing Shift while in Space+Tab kills
        // app-switching"). We forward the event WITH the held flag
        // stamped so macOS sees the combined state.
        let is_current_trigger = match self.state {
            State::Pending { trigger, .. }
            | State::Modifying { trigger, .. }
            | State::Comboing { trigger, .. }
            | State::EagerModifier { trigger, .. } => trigger == ev.key,
            State::Idle => false,
        };
        if ev.key.is_modifier() && !matches!(self.state, State::Idle) && !is_current_trigger {
            if let State::Modifying { held, .. } = self.state {
                if !held.is_empty() {
                    return Action::ForwardWithModifiers(held);
                }
            }
            return Action::Forward;
        }

        // Comboing — a modifier chord is held by us. The user's next
        // input either keeps it held (autorepeat of the same key),
        // tears it down (combo key up, or trigger up), or breaks out
        // of it (any other event — we emit the release sequence and
        // hand control back to Modifying). Handled BEFORE the
        // generic tuple-match below so we don't need a Copy-stable
        // SmallVec inside the State variant.
        if let State::Comboing { trigger, combo_key } = self.state {
            let combo_key_log = LogicalKey::Named(combo_key);
            // Combo-key KeyDown (incl. autorepeat) — chord modifiers
            // already held, just suppress.
            if ev.kind == EventKind::KeyDown && ev.key == combo_key_log {
                return Action::Suppress;
            }
            // Trigger autorepeat KeyDown (e.g. OS-driven repeat of
            // physically-held Space) — chord state intact, suppress.
            if ev.kind == EventKind::KeyDown && ev.key == trigger {
                return Action::Suppress;
            }
            // Combo-key KeyUp — drop the chord, return to layer.
            if ev.kind == EventKind::KeyUp && ev.key == combo_key_log {
                let release = self.combo_release.take().unwrap_or_default();
                self.state = State::Modifying {
                    trigger,
                    held: ModifierMask::EMPTY,
                };
                return Action::emit_or_suppress(release);
            }
            // Trigger KeyUp while combo still held — full teardown.
            if ev.kind == EventKind::KeyUp && ev.key == trigger {
                let release = self.combo_release.take().unwrap_or_default();
                self.state = State::Idle;
                return Action::emit_or_suppress(release);
            }
            // Anything else — release the chord cleanly and graduate
            // back to Modifying. The triggering event is dropped on
            // the floor; user can re-press the new key to fire its
            // own combo after the modifiers are freed. The
            // alternative (chaining straight into a new combo) would
            // need us to splice two Emit lists together AND replay
            // the new event through the rest of the match — for
            // little real-world benefit, since the user can just
            // release the current combo key first.
            let release = self.combo_release.take().unwrap_or_default();
            self.state = State::Modifying {
                trigger,
                held: ModifierMask::EMPTY,
            };
            return Action::emit_or_suppress(release);
        }

        // EagerModifier — a transparent-modifier trigger is physically held
        // (we injected its ModifierDown on press). Handled here, before the
        // tuple match, so the state stays a tap candidate until the first
        // real interruption. Modifier-key events (a *different* modifier, or
        // this trigger when it IS a modifier) for the non-trigger case are
        // already handled by the `is_modifier` short-circuit above.
        if let State::EagerModifier { trigger, modifier } = self.state {
            // Trigger autorepeat — modifier already held, swallow the repeat.
            if ev.kind == EventKind::KeyDown && ev.key == trigger {
                return Action::Suppress;
            }
            // Trigger release with nothing in between — a clean tap. Release
            // the modifier we eagerly pressed, then fire on_tap (if any).
            if ev.kind == EventKind::KeyUp && ev.key == trigger {
                self.state = State::Idle;
                let on_tap = self.binding_for(trigger).and_then(|b| b.on_tap.clone());
                let mut events: SmallVec<[SyntheticEvent; 8]> = SmallVec::new();
                events.push(SyntheticEvent::ModifierUp(modifier));
                if let Some(tap) = on_tap {
                    events.extend(tap.iter().copied());
                }
                return Action::EmitTap(events);
            }
            // Some other key goes down → the press is no longer a tap.
            if ev.kind == EventKind::KeyDown {
                // Another configured trigger preempts — but only when its hold
                // layer actually wants the held modifier (or is itself a
                // transparent layer). This mirrors the Pending→Pending preempt
                // guard: Shift→Space→1 hands over to Space's layer (its rules
                // use Shift), while Shift→Tab does NOT (so Shift+Tab stays the
                // OS reverse-focus chord). The eagerly-injected ModifierDown
                // stays physically held and is balanced by the user's real
                // modifier KeyUp later (forwarded by the is_modifier
                // short-circuit), so the held modifier shows up in the
                // GetAsyncKeyState mask for the new layer.
                if let Some(b) = binding.as_ref() {
                    if !ev.key.is_modifier()
                        && (b.uses_modifier(modifier)
                            || matches!(b.on_hold, ResolvedHold::TransparentModifier(_)))
                    {
                        self.state = State::Pending {
                            trigger: ev.key,
                            suppress_tap: true,
                        };
                        return Action::Suppress;
                    }
                }
                // Plain key interruption: promote to Modifying and forward the
                // key with the modifier (already down — no re-injection).
                self.state = State::Modifying {
                    trigger,
                    held: ModifierMask::just(modifier),
                };
                return Action::ForwardWithModifiers(ModifierMask::just(modifier));
            }
            // KeyUp of an unrelated key while still a tap candidate (e.g. a
            // modifier we forwarded through the short-circuit) — ignore.
            return Action::Forward;
        }

        let trigger_match = if binding.is_some() {
            Some(ev.key)
        } else {
            None
        };

        match (self.state, ev.kind, trigger_match, binding.as_ref()) {
            // -----------------------------------------------------------
            // Trigger key events (any bound top-level key).
            // -----------------------------------------------------------

            // Idle + trigger-down: enter Pending — UNLESS an external
            // (non-self) modifier is already held AND the trigger's
            // hold layer is a regular Explicit layer, in which case
            // the user is reaching for an OS-level chord (Cmd+Space →
            // Spotlight, Cmd+Tab → app switcher, Shift+Tab → reverse
            // focus, Win+L, Alt+Space, …). Forward the keydown so the
            // chord reaches the OS / app instead of being swallowed
            // into our trigger layer.
            //
            // Transparent-modifier triggers (CapsLock → Ctrl,
            // Shift → Shift, …) take a different path: with an
            // external modifier held the user's intent is to stack
            // modifiers (e.g. Shift held + CapsLock = "Ctrl+Shift+
            // next key"), not invoke an OS chord — CapsLock+Shift
            // isn't a real OS shortcut. Enter Pending but stamp
            // `suppress_tap` so a release-without-interruption
            // doesn't ghost-emit the on_tap (CapsLock's on_tap is
            // Escape — Shift+CapsLock alone shouldn't fire
            // Shift+Escape).
            //
            // Pre-emption of an already-Pending modifier trigger
            // (Shift-then-Space-then-N) is handled by the dedicated
            // arm below; that path runs from Pending, not Idle, so
            // this guard doesn't interfere with it.
            (State::Idle, EventKind::KeyDown, Some(t), Some(b)) => {
                let mut external = ev.modifiers;
                if let Some(self_mod) = key_self_modifier(t) {
                    external.remove(self_mod);
                }
                if !external.is_empty() {
                    // Two sub-cases when an external modifier is held.
                    //
                    // (a) Non-modifier trigger whose on_hold is
                    //     TransparentModifier — e.g. CapsLock-as-Ctrl.
                    //     CapsLock+Shift isn't a real OS shortcut, the
                    //     user's intent is to stack Ctrl on top of the
                    //     held Shift for "Ctrl+Shift+<next>". Enter
                    //     Pending with `suppress_tap=true` so a release-
                    //     without-interruption doesn't ghost-fire
                    //     CapsLock's on_tap (Escape) as Shift+Escape.
                    //
                    // (b) Anything else — forward the keydown so the OS
                    //     gets the chord (Cmd+Space → Spotlight,
                    //     Cmd+Tab → app switcher, Cmd+Shift+R, etc.).
                    //     Note that real modifier-key triggers
                    //     (Shift-as-trigger) fall into this bucket
                    //     deliberately: when the user holds Cmd and
                    //     taps Shift, we must NOT consume Shift —
                    //     they're reaching for Cmd+Shift+X.
                    if !t.is_modifier() && matches!(b.on_hold, ResolvedHold::TransparentModifier(_))
                    {
                        self.state = State::Pending {
                            trigger: t,
                            suppress_tap: true,
                        };
                        Action::Suppress
                    } else {
                        Action::Forward
                    }
                } else if let ResolvedHold::TransparentModifier(m) = &b.on_hold {
                    // Transparent-modifier trigger pressed clean (no external
                    // modifier): press the real modifier NOW so it's genuinely
                    // held for mouse clicks and any subsequent key — not only
                    // after a keyboard interruption. A clean release still
                    // fires on_tap (see the EagerModifier block above).
                    let m = resolve_modifier_for_trigger(*m, t);
                    self.state = State::EagerModifier {
                        trigger: t,
                        modifier: m,
                    };
                    Action::emit([SyntheticEvent::ModifierDown(m)])
                } else {
                    self.state = State::Pending {
                        trigger: t,
                        suppress_tap: false,
                    };
                    Action::Suppress
                }
            }

            // Autorepeat trigger-down on the CURRENT trigger: suppress.
            (
                State::Pending { trigger: ts, .. } | State::Modifying { trigger: ts, .. },
                EventKind::KeyDown,
                Some(te),
                _,
            ) if ts == te => Action::Suppress,

            // Trigger-up of the CURRENT trigger in Pending: pure tap. Use
            // `EmitTap` (not `Emit`) so the macOS platform layer posts
            // the synthesized events with flags=0 rather than inheriting
            // the trigger-up event's flag state — which can include stale
            // synthetic-modifier flags and make e.g. Esc arrive as
            // Ctrl+Esc in Zed. `suppress_tap` (set when the trigger
            // entered Pending under a held external modifier on a
            // transparent-modifier layer) gates the on_tap emission so
            // CapsLock-as-Ctrl can be combined with Shift without
            // ghost-emitting Escape.
            (
                State::Pending {
                    trigger: ts,
                    suppress_tap,
                },
                EventKind::KeyUp,
                Some(te),
                Some(b),
            ) if ts == te => {
                self.state = State::Idle;
                if suppress_tap {
                    return Action::Suppress;
                }
                match &b.on_tap {
                    Some(events) => Action::emit_tap(events.iter().copied()),
                    None => Action::Suppress,
                }
            }

            // Trigger-up of the CURRENT trigger in Modifying: release the held
            // modifiers (if any), in reverse of the press order so nesting
            // stays balanced.
            (State::Modifying { trigger: ts, held }, EventKind::KeyUp, Some(te), _) if ts == te => {
                self.state = State::Idle;
                if held.is_empty() {
                    Action::Suppress
                } else {
                    Action::emit(held.modifiers().into_iter().rev().map(SyntheticEvent::ModifierUp))
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
            (State::Pending { trigger: ts, .. }, EventKind::KeyDown, Some(te), Some(b))
                if ts != te
                    && ts.is_modifier()
                    && !te.is_modifier()
                    && (key_self_modifier(ts).is_some_and(|m| b.uses_modifier(m))
                        || matches!(b.on_hold, ResolvedHold::TransparentModifier(_))) =>
            {
                // Stamp `suppress_tap` so the preempted trigger doesn't
                // ghost-fire its on_tap if the user releases it without
                // pressing anything else (Shift held + tap CapsLock-as-Ctrl
                // shouldn't emit CapsLock's Escape into the app).
                self.state = State::Pending {
                    trigger: te,
                    suppress_tap: true,
                };
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
            (State::Pending { trigger, .. }, EventKind::KeyDown, _, _) => {
                let Some(binding) = self.binding_for(trigger) else {
                    // Shouldn't happen — we only enter Pending when the
                    // binding exists. Defensive fallback.
                    self.state = State::Idle;
                    return Action::Forward;
                };
                self.handle_interruption(trigger, &binding, ev.key, ev.modifiers)
            }

            // In Modifying with no held modifier (an explicit override just
            // fired for a nav-style binding), a new key-down for any other
            // key should re-fire the override. Chord-style bindings
            // never come back here — they enter Comboing on press
            // and are torn down via the Comboing block above.
            (
                State::Modifying { trigger, held },
                EventKind::KeyDown,
                _,
                _,
            ) if held.is_empty() => {
                let Some(binding) = self.binding_for(trigger) else {
                    return Action::Forward;
                };
                self.handle_interruption(trigger, &binding, ev.key, ev.modifiers)
            }

            // In Modifying with held modifier(s): forward the event with the
            // modifier flag(s) asserted. Windows' SendInput already updated
            // the global key state so flags propagate naturally on that
            // platform, but macOS needs explicit per-event flag overrides.
            // Both platforms accept `ForwardWithModifiers`; the macOS path
            // stamps the flags, the Windows path treats it as a plain
            // Forward. Skip modifiers themselves — they forward through
            // the earlier short-circuit.
            (State::Modifying { held, .. }, _, _, _)
                if !held.is_empty() && !ev.key.is_modifier() =>
            {
                Action::ForwardWithModifiers(held)
            }

            // Anything else: forward. Covers Idle + key we don't bind,
            // orphan key-ups in Modifying{held: None}, etc.
            _ => Action::Forward,
        }
    }

    /// A pointer (mouse) button went down. The keyboard hook can't observe
    /// mouse input, so the platform layer feeds clicks here. While a
    /// transparent-modifier trigger is an un-interrupted tap candidate
    /// (`EagerModifier`), a click counts as an interruption: it cancels the
    /// pending `on_tap` and promotes us to `Modifying`, so e.g. Shift-tap
    /// won't open the search window when the user actually meant Shift+Click.
    /// The modifier is already physically held (injected on press), so the
    /// click carries it natively — nothing to inject here. A no-op in every
    /// other state.
    pub fn on_pointer_down(&mut self) -> Action {
        if let State::EagerModifier { trigger, modifier } = self.state {
            self.state = State::Modifying {
                trigger,
                held: ModifierMask::just(modifier),
            };
            return Action::Suppress;
        }
        Action::Forward
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
                self.state = State::Modifying {
                    trigger,
                    held: ModifierMask::EMPTY,
                };
                Action::Forward
            }

            ResolvedHold::TransparentModifier(m) => {
                let m = resolve_modifier_for_trigger(*m, trigger);
                self.state = State::Modifying {
                    trigger,
                    held: ModifierMask::just(m),
                };
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
                Action::emit_then_forward_with_modifiers(
                    [SyntheticEvent::ModifierDown(m)],
                    ModifierMask::just(m),
                )
            }

            ResolvedHold::Explicit {
                overrides,
                fallback,
            } => {
                // Explicit override lookup: try the exact (modifiers, key)
                // pair first, then fall back to the unqualified (empty,
                // key) form so rules authored without modifier prefixes
                // still fire when the user happens to be holding e.g.
                // Shift. The fallback-modifier path below then stamps the
                // physical modifier onto the synthesized output.
                //
                // Two output shapes per match:
                //   * chord-style (any ModifierDown in the press list,
                //     e.g. `[ctrl, alt, cmd, d]`): emit the press,
                //     stash the release, enter `Comboing`. The chord
                //     stays "physically held" until the combo key (or
                //     trigger) comes up — push-to-talk through remap.
                //   * nav-style (no modifier injection, e.g.
                //     `[left]`): emit press+release back-to-back as
                //     a flat tap and stay in `Modifying { held: None }`.
                //     Subsequent OS autorepeats of the combo key
                //     fall back into this same arm and re-fire the
                //     tap, so Space+H produces a continuous Left
                //     arrow stream the way users expect from a nav
                //     binding.
                if let LogicalKey::Named(nk) = other {
                    let pair = mods
                        .lookup_candidates()
                        .into_iter()
                        .find_map(|candidate| overrides.get(&(candidate, nk)))
                        .or_else(|| {
                            if mods.is_empty() {
                                None
                            } else {
                                overrides.get(&(ModifierMask::EMPTY, nk))
                            }
                        });
                    if let Some(pair) = pair {
                        // Enter the held (`Comboing`) path when the press
                        // either holds modifiers (push-to-talk chord) or is a
                        // workspace switch. The latter must fire exactly once
                        // — not re-fire on every autorepeat the way nav-style
                        // bindings do — because the platform layer's
                        // alternate-desktop toggle would otherwise ping-pong
                        // between desktops while the key stays down.
                        let enter_held = pair.on_press.iter().any(|e| {
                            matches!(
                                e,
                                SyntheticEvent::ModifierDown(_)
                                    | SyntheticEvent::SwitchToWorkspace(_)
                            )
                        });
                        if enter_held {
                            // Emit press, stash the release sequence (empty
                            // for a workspace switch — nothing to undo), and
                            // wait for the combo key (or trigger) to come up.
                            self.combo_release = Some(pair.on_release.clone());
                            self.state = State::Comboing {
                                trigger,
                                combo_key: nk,
                            };
                            return Action::emit(pair.on_press.iter().copied());
                        }
                        // Nav-style: flat tap, stay in Modifying so
                        // OS autorepeats keep re-firing the tap.
                        self.state = State::Modifying {
                            trigger,
                            held: ModifierMask::EMPTY,
                        };
                        let mut events: SmallVec<[SyntheticEvent; 8]> = SmallVec::new();
                        events.extend(pair.on_press.iter().copied());
                        events.extend(pair.on_release.iter().copied());
                        return Action::Emit(events);
                    }
                }

                // No override → fallback modifiers, if configured.
                // Inject the modifier-downs only and forward the user's
                // real keystroke with the flags stamped — see the
                // TransparentModifier comment above for the macOS-app-
                // -switcher rationale (synth events get filtered by the
                // switcher's input handling, so Space+Tab needs a real
                // Tab to flow through, not a synthesized one). A fallback
                // may carry several modifiers (`[any] → [ctrl, shift]`).
                if !fallback.is_empty() {
                    self.state = State::Modifying {
                        trigger,
                        held: *fallback,
                    };
                    let downs = fallback
                        .modifiers()
                        .into_iter()
                        .map(SyntheticEvent::ModifierDown);
                    return Action::emit_then_forward_with_modifiers(downs, *fallback);
                }

                // No override, no fallback → forward the naked key
                // unchanged. State stays in `held: <empty>` so the next
                // press of any other key re-fires the override path.
                self.state = State::Modifying {
                    trigger,
                    held: ModifierMask::EMPTY,
                };
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
        LogicalKey::LeftShift => Some(Modifier::LeftShift),
        LogicalKey::RightShift => Some(Modifier::RightShift),
        LogicalKey::Ctrl => Some(Modifier::Ctrl),
        LogicalKey::LeftCtrl => Some(Modifier::LeftCtrl),
        LogicalKey::RightCtrl => Some(Modifier::RightCtrl),
        LogicalKey::Alt => Some(Modifier::Alt),
        LogicalKey::LeftAlt => Some(Modifier::LeftAlt),
        LogicalKey::RightAlt => Some(Modifier::RightAlt),
        LogicalKey::Cmd => Some(Modifier::Cmd),
        LogicalKey::LeftCmd => Some(Modifier::LeftCmd),
        LogicalKey::RightCmd => Some(Modifier::RightCmd),
        _ => None,
    }
}

fn generic_modifier_key(k: LogicalKey) -> Option<LogicalKey> {
    match k {
        LogicalKey::LeftShift | LogicalKey::RightShift => Some(LogicalKey::Shift),
        LogicalKey::LeftCtrl | LogicalKey::RightCtrl => Some(LogicalKey::Ctrl),
        LogicalKey::LeftAlt | LogicalKey::RightAlt => Some(LogicalKey::Alt),
        LogicalKey::LeftCmd | LogicalKey::RightCmd => Some(LogicalKey::Cmd),
        _ => None,
    }
}

fn resolve_modifier_for_trigger(m: Modifier, trigger: LogicalKey) -> Modifier {
    if m.side() != ModifierSide::Any {
        return m;
    }
    let Some(trigger_modifier) = key_self_modifier(trigger) else {
        return m;
    };
    if trigger_modifier.base() == m.base() {
        trigger_modifier
    } else {
        m
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
    /// Stand-in for an OS-driven autorepeat KeyDown. The state
    /// machine treats it identically to a fresh KeyDown (Comboing
    /// suppresses any duplicate combo-key down; nav paths re-fire on
    /// every KeyDown) so the alias is just naming-for-intent in test
    /// bodies.
    fn down_autorepeat(k: LogicalKey) -> RawEvent {
        down(k)
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
    fn up_with_mods(k: LogicalKey, modifiers: ModifierMask) -> RawEvent {
        RawEvent {
            kind: EventKind::KeyUp,
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
        // Eager: pressing CapsLock injects the real Ctrl immediately so it's
        // held for clicks/keys. A clean tap releases Ctrl and then fires the
        // on_tap (Escape).
        assert_eq!(
            m.on_event(down(LogicalKey::CapsLock)),
            emit(vec![SyntheticEvent::ModifierDown(Modifier::Ctrl)])
        );
        assert_eq!(
            m.on_event(up(LogicalKey::CapsLock)),
            emit_tap(vec![
                SyntheticEvent::ModifierUp(Modifier::Ctrl),
                SyntheticEvent::KeyDown(NamedKey::Escape),
                SyntheticEvent::KeyUp(NamedKey::Escape),
            ])
        );
    }

    #[test]
    fn capslock_hold_becomes_transparent_ctrl() {
        let mut m = sm(CAPS_CTRL_ESC);
        // Eager: Ctrl is injected on press, so the first interrupting key just
        // forwards with the (already-held) Ctrl flag — no second ModifierDown.
        assert_eq!(
            m.on_event(down(LogicalKey::CapsLock)),
            emit(vec![SyntheticEvent::ModifierDown(Modifier::Ctrl)])
        );
        assert_eq!(
            m.on_event(down(alpha('C'))),
            Action::ForwardWithModifiers(ModifierMask::just(Modifier::Ctrl))
        );
        // A subsequent key while CapsLock is still held must also carry the
        // Ctrl flag forward — on macOS the real V keydown needs explicit flag
        // stamping or it arrives with flags=0 and is interpreted as plain V.
        assert_eq!(
            m.on_event(down(alpha('V'))),
            Action::ForwardWithModifiers(ModifierMask::just(Modifier::Ctrl))
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
        // Chord-style override (has modifiers): KeyDown emits the
        // press half and enters Comboing; KeyUp emits the release
        // half and falls back to Modifying. Together this is what
        // used to be a single packed-tap emission, but now the
        // modifiers stay held for as long as W is physically held —
        // turning Space+W from a microsecond tap into a real
        // hold-to-fire chord.
        let mut m = sm(SPACE_MAC);
        m.on_event(down(LogicalKey::Space));
        assert_eq!(
            m.on_event(down(alpha('W'))),
            emit(vec![
                SyntheticEvent::ModifierDown(Modifier::Ctrl),
                SyntheticEvent::ModifierDown(Modifier::Alt),
                SyntheticEvent::KeyDown(NamedKey::Alpha(b'S')),
            ])
        );
        assert_eq!(
            m.on_event(up(alpha('W'))),
            emit(vec![
                SyntheticEvent::KeyUp(NamedKey::Alpha(b'S')),
                SyntheticEvent::ModifierUp(Modifier::Alt),
                SyntheticEvent::ModifierUp(Modifier::Ctrl),
            ])
        );
        // Override fired and was torn down -> no transparent
        // modifier left to release; Space-up suppresses.
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
            Action::EmitThenForwardWithModifiers(
                smallvec::smallvec![SyntheticEvent::ModifierDown(Modifier::Cmd)],
                ModifierMask::just(Modifier::Cmd),
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
        // Press half: Alt-down, F4-down.
        assert_eq!(
            m.on_event(down(alpha('Q'))),
            emit(vec![
                SyntheticEvent::ModifierDown(Modifier::Alt),
                SyntheticEvent::KeyDown(NamedKey::F4),
            ])
        );
        // Release half: F4-up, Alt-up — emitted on Q's KeyUp.
        assert_eq!(
            m.on_event(up(alpha('Q'))),
            emit(vec![
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
        // Press half on `↓.
        assert_eq!(
            m.on_event(down(named(NamedKey::Backtick))),
            emit(vec![
                SyntheticEvent::ModifierDown(Modifier::Win),
                SyntheticEvent::KeyDown(NamedKey::Backtick),
            ])
        );
        // Release half on `↑.
        assert_eq!(
            m.on_event(up(named(NamedKey::Backtick))),
            emit(vec![
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
            Action::EmitThenForwardWithModifiers(
                smallvec::smallvec![SyntheticEvent::ModifierDown(Modifier::Cmd)],
                ModifierMask::just(Modifier::Cmd),
            )
        );
        // Tab released: forward the real Tab↑ with Cmd stamped — switcher
        // sees a real release, no synth state to confuse it.
        assert_eq!(
            m.on_event(up(named(NamedKey::Tab))),
            Action::ForwardWithModifiers(ModifierMask::just(Modifier::Cmd))
        );
        // Second physical tap inside the same Space-hold: forward path
        // again. Cmd stays continuously held via the trigger, switcher
        // stays open, advances one slot per tap (matches native Cmd+Tab).
        assert_eq!(
            m.on_event(down(named(NamedKey::Tab))),
            Action::ForwardWithModifiers(ModifierMask::just(Modifier::Cmd))
        );
        assert_eq!(
            m.on_event(up(named(NamedKey::Tab))),
            Action::ForwardWithModifiers(ModifierMask::just(Modifier::Cmd))
        );
        // User reaches for Shift to do Cmd+Shift+Tab (previous app).
        // Without the modifier-passthrough's `held` stamp, a real
        // Shift FlagsChanged event would let macOS reconcile its
        // modifier state against real hardware and drop the
        // synth-asserted Cmd bit — the switcher would close as if
        // the user had let go of Cmd. Stamping our held modifier on
        // the forwarded event keeps Cmd in the OS-visible flag set.
        assert_eq!(
            m.on_event(down(LogicalKey::Shift)),
            Action::ForwardWithModifiers(ModifierMask::just(Modifier::Cmd))
        );
        // Now Cmd+Shift+Tab: Tab forwarded with Cmd stamped + Shift
        // bit from the still-held physical Shift → app switcher
        // sees Cmd+Shift+Tab, goes BACKWARDS one slot.
        assert_eq!(
            m.on_event(down(named(NamedKey::Tab))),
            Action::ForwardWithModifiers(ModifierMask::just(Modifier::Cmd))
        );
        assert_eq!(
            m.on_event(up(named(NamedKey::Tab))),
            Action::ForwardWithModifiers(ModifierMask::just(Modifier::Cmd))
        );
        // Shift released — same stamping rule keeps Cmd alive.
        assert_eq!(
            m.on_event(up(LogicalKey::Shift)),
            Action::ForwardWithModifiers(ModifierMask::just(Modifier::Cmd))
        );
        // Releasing Space emits ModifierUp(Cmd) — closes the switcher,
        // selected app activates.
        assert_eq!(
            m.on_event(up(LogicalKey::Space)),
            emit(vec![SyntheticEvent::ModifierUp(Modifier::Cmd)])
        );
    }

    // Multi-modifier `[any]` fallback: while Tab is held, an unmapped key is
    // forwarded with BOTH Ctrl and Shift stamped, and Tab-up releases both in
    // reverse order. This is the user-facing feature: `[any] → [ctrl, shift]`
    // turns a hold layer into an ad-hoc Ctrl+Shift modifier.
    #[test]
    fn tab_any_fallback_stamps_multiple_modifiers() {
        let yaml = r#"
tab:
  on_tap: [tab]
  on_hold:
    - { keys: [j], to_hotkey: [ctrl, tab] }
    - { keys: [any], to_hotkey: [ctrl, shift] }
"#;
        let ctrl_shift = ModifierMask::from_iter([Modifier::Ctrl, Modifier::Shift]);
        let mut m = sm(yaml);
        // Tab down — enter the hold layer.
        assert_eq!(m.on_event(down(named(NamedKey::Tab))), Action::Suppress);
        // First unmapped key (D): inject Ctrl↓ + Shift↓, forward the real D
        // with both flags stamped.
        assert_eq!(
            m.on_event(down(alpha('D'))),
            Action::EmitThenForwardWithModifiers(
                smallvec::smallvec![
                    SyntheticEvent::ModifierDown(Modifier::Ctrl),
                    SyntheticEvent::ModifierDown(Modifier::Shift),
                ],
                ctrl_shift,
            )
        );
        // D released, still inside the layer: forwarded with both stamped.
        assert_eq!(
            m.on_event(up(alpha('D'))),
            Action::ForwardWithModifiers(ctrl_shift)
        );
        // A second unmapped key (F): modifiers already held, just forward with
        // both flags — no re-injection.
        assert_eq!(
            m.on_event(down(alpha('F'))),
            Action::ForwardWithModifiers(ctrl_shift)
        );
        // Tab-up releases both modifiers, reverse of the press order.
        assert_eq!(
            m.on_event(up(named(NamedKey::Tab))),
            emit(vec![
                SyntheticEvent::ModifierUp(Modifier::Shift),
                SyntheticEvent::ModifierUp(Modifier::Ctrl),
            ])
        );
    }

    // Bug A: holding Space and tapping the target key twice should fire
    // the explicit override on each tap, not just the first. With the
    // push-to-talk model, each tap = press half on Q↓, release half on
    // Q↑, then another press/release pair on the second tap.
    #[test]
    fn space_plus_q_refires_on_repeat_tap() {
        let mut m = sm(SPACE_WIN);
        m.on_event(down(LogicalKey::Space));
        let press = || {
            emit(vec![
                SyntheticEvent::ModifierDown(Modifier::Alt),
                SyntheticEvent::KeyDown(NamedKey::F4),
            ])
        };
        let release = || {
            emit(vec![
                SyntheticEvent::KeyUp(NamedKey::F4),
                SyntheticEvent::ModifierUp(Modifier::Alt),
            ])
        };
        assert_eq!(m.on_event(down(alpha('Q'))), press());
        assert_eq!(m.on_event(up(alpha('Q'))), release());
        // Second tap, still holding Space — must fire the override again.
        assert_eq!(m.on_event(down(alpha('Q'))), press());
        assert_eq!(m.on_event(up(alpha('Q'))), release());
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
        // Q still fires the override (press half on Q↓).
        assert_eq!(
            m.on_event(down(alpha('Q'))),
            emit(vec![
                SyntheticEvent::ModifierDown(Modifier::Alt),
                SyntheticEvent::KeyDown(NamedKey::F4),
            ])
        );
        // Q↑ emits the release half.
        assert_eq!(
            m.on_event(up(alpha('Q'))),
            emit(vec![
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

        // Tap path. Eager: Shift goes down on press; a clean release lets
        // Shift up and then fires on_tap (Cmd+Space).
        assert_eq!(
            m.on_event(down(LogicalKey::Shift)),
            emit(vec![SyntheticEvent::ModifierDown(Modifier::Shift)])
        );
        assert_eq!(
            m.on_event(up(LogicalKey::Shift)),
            emit_tap(vec![
                SyntheticEvent::ModifierUp(Modifier::Shift),
                SyntheticEvent::ModifierDown(Modifier::Cmd),
                SyntheticEvent::KeyDown(NamedKey::Space),
                SyntheticEvent::KeyUp(NamedKey::Space),
                SyntheticEvent::ModifierUp(Modifier::Cmd),
            ])
        );

        // Hold path — Shift+L. Shift was injected on press, so the
        // interrupting L just forwards with Shift stamped (no re-injection).
        m.on_event(down(LogicalKey::Shift));
        assert_eq!(
            m.on_event(down(alpha('L'))),
            Action::ForwardWithModifiers(ModifierMask::just(Modifier::Shift))
        );
        // Second L while still held: forwarded with Shift stamped.
        assert_eq!(
            m.on_event(up(alpha('L'))),
            Action::ForwardWithModifiers(ModifierMask::just(Modifier::Shift))
        );
        assert_eq!(
            m.on_event(down(alpha('L'))),
            Action::ForwardWithModifiers(ModifierMask::just(Modifier::Shift))
        );
        // Shift-up releases the held modifier.
        assert_eq!(
            m.on_event(up(LogicalKey::Shift)),
            emit(vec![SyntheticEvent::ModifierUp(Modifier::Shift)])
        );
    }

    #[test]
    fn generic_shift_trigger_matches_right_shift_and_preserves_side() {
        let yaml = r#"
shift:
  on_tap: [escape]
"#;
        let mut m = sm(yaml);
        assert_eq!(
            m.on_event(down(LogicalKey::RightShift)),
            emit(vec![SyntheticEvent::ModifierDown(Modifier::RightShift)])
        );
        assert_eq!(
            m.on_event(up(LogicalKey::RightShift)),
            emit_tap(vec![
                SyntheticEvent::ModifierUp(Modifier::RightShift),
                SyntheticEvent::KeyDown(NamedKey::Escape),
                SyntheticEvent::KeyUp(NamedKey::Escape),
            ])
        );
    }

    #[test]
    fn side_specific_trigger_overrides_generic_trigger() {
        let yaml = r#"
shift:
  on_tap: [escape]
right_shift:
  on_tap: [tab]
"#;
        let mut m = sm(yaml);
        assert_eq!(
            m.on_event(down(LogicalKey::LeftShift)),
            emit(vec![SyntheticEvent::ModifierDown(Modifier::LeftShift)])
        );
        assert_eq!(
            m.on_event(up(LogicalKey::LeftShift)),
            emit_tap(vec![
                SyntheticEvent::ModifierUp(Modifier::LeftShift),
                SyntheticEvent::KeyDown(NamedKey::Escape),
                SyntheticEvent::KeyUp(NamedKey::Escape),
            ])
        );

        assert_eq!(
            m.on_event(down(LogicalKey::RightShift)),
            emit(vec![SyntheticEvent::ModifierDown(Modifier::RightShift)])
        );
        assert_eq!(
            m.on_event(up(LogicalKey::RightShift)),
            emit_tap(vec![
                SyntheticEvent::ModifierUp(Modifier::RightShift),
                SyntheticEvent::KeyDown(NamedKey::Tab),
                SyntheticEvent::KeyUp(NamedKey::Tab),
            ])
        );
    }

    #[test]
    fn sided_and_generic_modifier_prefixes_match_physical_sides() {
        let yaml = r#"
space:
  on_tap: [space]
  on_hold:
    - { keys: [right_shift, 1], switch_to_workspace: 1 }
    - { keys: [shift, 2], switch_to_workspace: 2 }
"#;
        let mut right_shift = ModifierMask::EMPTY;
        right_shift.insert(Modifier::RightShift);
        let mut left_shift = ModifierMask::EMPTY;
        left_shift.insert(Modifier::LeftShift);

        let mut m = sm(yaml);
        m.on_event(down(LogicalKey::Space));
        assert_eq!(
            m.on_event(down_with_mods(alpha('1'), right_shift)),
            emit(vec![SyntheticEvent::SwitchToWorkspace(1)])
        );
        assert_eq!(m.on_event(up(alpha('1'))), Action::Suppress);
        assert_eq!(m.on_event(up(LogicalKey::Space)), Action::Suppress);

        m.on_event(down(LogicalKey::Space));
        assert_eq!(
            m.on_event(down_with_mods(alpha('1'), left_shift)),
            Action::Forward
        );
        assert_eq!(m.on_event(up(LogicalKey::Space)), Action::Suppress);

        m.on_event(down(LogicalKey::Space));
        assert_eq!(
            m.on_event(down_with_mods(alpha('2'), left_shift)),
            emit(vec![SyntheticEvent::SwitchToWorkspace(2)])
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

        // Bare Space+1: unqualified rule fires once on press. The switch runs
        // through the held path (so it doesn't re-fire on autorepeat), which
        // swallows the combo-key release — there's nothing to emit on key-up.
        m.on_event(down(LogicalKey::Space));
        assert_eq!(
            m.on_event(down(alpha('1'))),
            emit(vec![SyntheticEvent::SwitchToWorkspace(1)])
        );
        assert_eq!(m.on_event(up(alpha('1'))), Action::Suppress);
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
    fn switch_to_workspace_fires_once_and_suppresses_autorepeat() {
        // A workspace switch runs through the held path: it fires exactly
        // once on press and swallows the OS autorepeat of the held digit, so
        // we don't re-switch desktops on every repeat (which would ping-pong
        // the platform layer's alternate-desktop toggle). The release has
        // nothing to undo, so the key-up is simply suppressed.
        let yaml = r#"
space:
  on_tap: [space]
  on_hold:
    - keys: [1]
      switch_to_workspace: 1
"#;
        let mut m = sm(yaml);
        m.on_event(down(LogicalKey::Space));
        assert_eq!(
            m.on_event(down(alpha('1'))),
            emit(vec![SyntheticEvent::SwitchToWorkspace(1)])
        );
        // Held digit autorepeats — suppressed, no second switch.
        assert_eq!(m.on_event(down_autorepeat(alpha('1'))), Action::Suppress);
        // Releasing the trigger while the digit is still down tears the
        // chord down; nothing to emit.
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

        // Shift first — goes eager: the real Shift is injected now.
        assert_eq!(
            m.on_event(down(LogicalKey::Shift)),
            emit(vec![SyntheticEvent::ModifierDown(Modifier::Shift)])
        );

        // Space second — pre-empts Shift, enters Pending(Space). Shift's tap
        // is abandoned; the eagerly-injected Shift stays held (balanced by the
        // real Shift-up later) and shows up on the subsequent 1 keydown's mask.
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

        // Shift first — goes eager (the self-flag isn't an external modifier).
        assert_eq!(
            m.on_event(down(LogicalKey::Shift)),
            emit(vec![SyntheticEvent::ModifierDown(Modifier::Shift)])
        );

        // Tab arrives with Shift held in the modifier mask. Tab's on_hold
        // rules use only `j` and `k` (no shift-qualified rules), so the
        // preempt guard rejects handing the layer to Tab. It's a plain
        // interruption: Shift is already physically down (injected on press),
        // so we just forward the real Tab↓ with the Shift flag stamped —
        // Shift+Tab reaches the OS as the reverse-focus chord.
        let mut shift = ModifierMask::EMPTY;
        shift.insert(Modifier::Shift);
        assert_eq!(
            m.on_event(down_with_mods(named(NamedKey::Tab), shift)),
            Action::ForwardWithModifiers(ModifierMask::just(Modifier::Shift))
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
        // Eager: Shift injected on press.
        assert_eq!(
            m.on_event(down(LogicalKey::Shift)),
            emit(vec![SyntheticEvent::ModifierDown(Modifier::Shift)])
        );

        let mut shift = ModifierMask::EMPTY;
        shift.insert(Modifier::Shift);
        // Space has a `keys: [shift, 1]` override — its hold layer uses Shift,
        // so the EagerModifier preempt hands the layer to Space (Pending).
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
    fn modifier_trigger_alone_with_self_flag_goes_eager() {
        // Real platform delivers Shift's own keydown with the Shift flag
        // already set. The self-flag must not look like an external modifier —
        // a lone Shift press goes eager (Shift down now), and Shift-tap-for-Esc
        // still works on release (Shift up, then Escape).
        let yaml = r#"
shift:
  on_tap: [escape]
"#;
        let mut m = sm(yaml);
        let mut shift_self = ModifierMask::EMPTY;
        shift_self.insert(Modifier::Shift);
        assert_eq!(
            m.on_event(down_with_mods(LogicalKey::Shift, shift_self)),
            emit(vec![SyntheticEvent::ModifierDown(Modifier::Shift)])
        );
        assert_eq!(
            m.on_event(up(LogicalKey::Shift)),
            emit_tap(vec![
                SyntheticEvent::ModifierUp(Modifier::Shift),
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
        // Ctrl+F13 (or any other unmapped non-Named key). Eager: Ctrl was
        // injected on CapsLock-down, so the unmapped key just forwards with
        // the Ctrl flag stamped (the platform layer stamps it for keys we
        // can't synthesize). No second ModifierDown.
        let mut m = sm(CAPS_CTRL_ESC);
        assert_eq!(
            m.on_event(down(LogicalKey::CapsLock)),
            emit(vec![SyntheticEvent::ModifierDown(Modifier::Ctrl)])
        );
        assert_eq!(
            m.on_event(down(LogicalKey::Other)),
            Action::ForwardWithModifiers(ModifierMask::just(Modifier::Ctrl))
        );
        assert_eq!(
            m.on_event(up(LogicalKey::CapsLock)),
            emit(vec![SyntheticEvent::ModifierUp(Modifier::Ctrl)])
        );
    }

    // Reported user bug: with `shift: { on_tap: [cmd, space] }`, holding
    // Shift, clicking the mouse, then releasing Shift was firing Cmd+Space —
    // the search/palette popped up after every Shift+click. Now Shift goes
    // down eagerly (so the click carries it natively) and the platform layer
    // feeds the click in via `on_pointer_down`, which cancels the pending tap
    // so Shift-up just releases the modifier.
    #[test]
    fn shift_eager_then_mouse_click_does_not_fire_on_tap() {
        let yaml = r#"
shift:
  on_tap: [cmd, space]
"#;
        let mut m = sm(yaml);
        // Press Shift — real Shift injected now (carries onto the click).
        assert_eq!(
            m.on_event(down(LogicalKey::Shift)),
            emit(vec![SyntheticEvent::ModifierDown(Modifier::Shift)])
        );
        // Mouse button down cancels the tap; nothing to inject — Shift is
        // already held, so the click is Shift+click.
        assert_eq!(m.on_pointer_down(), Action::Suppress);
        // Releasing Shift only releases the modifier — no Cmd+Space.
        assert_eq!(
            m.on_event(up(LogicalKey::Shift)),
            emit(vec![SyntheticEvent::ModifierUp(Modifier::Shift)])
        );
    }

    // A mouse click with no transparent modifier held is a pure no-op for the
    // state machine — the click passes through untouched.
    #[test]
    fn pointer_down_is_noop_when_idle() {
        let yaml = r#"
shift:
  on_tap: [cmd, space]
"#;
        let mut m = sm(yaml);
        assert_eq!(m.on_pointer_down(), Action::Forward);
    }

    // -----------------------------------------------------------------
    // Push-to-talk through remap: modifier-chord on_hold bindings hold
    // their modifiers for as long as the combo key is physically held,
    // and only emit the release sequence when the user lets it go.

    const SPACE_PTT: &str = r#"
space:
  on_tap: [space]
  on_hold:
    - { keys: [d], to_hotkey: [ctrl, alt, cmd, d] }
    - { keys: [h], to_hotkey: [left] }
"#;

    #[test]
    fn space_plus_d_holds_chord_until_combo_key_up() {
        let mut m = sm(SPACE_PTT);
        m.on_event(down(LogicalKey::Space));
        // D-down emits PRESS half only — modifiers stay held.
        assert_eq!(
            m.on_event(down(alpha('D'))),
            emit(vec![
                SyntheticEvent::ModifierDown(Modifier::Ctrl),
                SyntheticEvent::ModifierDown(Modifier::Alt),
                SyntheticEvent::ModifierDown(Modifier::Cmd),
                SyntheticEvent::KeyDown(NamedKey::Alpha(b'D')),
            ])
        );
        // OS autorepeats of D while user keeps it held — modifiers
        // already held, just suppress so the chord doesn't strobe.
        assert_eq!(m.on_event(down_autorepeat(alpha('D'))), Action::Suppress);
        assert_eq!(m.on_event(down_autorepeat(alpha('D'))), Action::Suppress);
        // D-up emits the matching RELEASE half (mirror order).
        assert_eq!(
            m.on_event(up(alpha('D'))),
            emit(vec![
                SyntheticEvent::KeyUp(NamedKey::Alpha(b'D')),
                SyntheticEvent::ModifierUp(Modifier::Cmd),
                SyntheticEvent::ModifierUp(Modifier::Alt),
                SyntheticEvent::ModifierUp(Modifier::Ctrl),
            ])
        );
        // Chord already torn down — Space-up has nothing left to clean
        // up, just suppress.
        assert_eq!(m.on_event(up(LogicalKey::Space)), Action::Suppress);
    }

    #[test]
    fn space_plus_d_releasing_trigger_first_tears_down_chord() {
        // User releases Space while still holding D. We must emit the
        // release sequence so the OS doesn't see stuck modifiers.
        let mut m = sm(SPACE_PTT);
        m.on_event(down(LogicalKey::Space));
        m.on_event(down(alpha('D')));
        assert_eq!(
            m.on_event(up(LogicalKey::Space)),
            emit(vec![
                SyntheticEvent::KeyUp(NamedKey::Alpha(b'D')),
                SyntheticEvent::ModifierUp(Modifier::Cmd),
                SyntheticEvent::ModifierUp(Modifier::Alt),
                SyntheticEvent::ModifierUp(Modifier::Ctrl),
            ])
        );
    }

    #[test]
    fn space_plus_h_nav_emits_flat_tap_per_press() {
        // Nav-style emit (no modifiers in to_hotkey): the chord is
        // emitted as a back-to-back press+release tap. State stays in
        // Modifying so the next H KeyDown — autorepeat or fresh —
        // re-fires the tap. Continuous Left arrow on Space+H hold is
        // exactly what users expect for nav bindings.
        let mut m = sm(SPACE_PTT);
        m.on_event(down(LogicalKey::Space));
        let left_tap = || {
            emit(vec![
                SyntheticEvent::KeyDown(NamedKey::Left),
                SyntheticEvent::KeyUp(NamedKey::Left),
            ])
        };
        assert_eq!(m.on_event(down(alpha('H'))), left_tap());
        // Autorepeat KeyDown: re-fires the tap.
        assert_eq!(m.on_event(down_autorepeat(alpha('H'))), left_tap());
        assert_eq!(m.on_event(down_autorepeat(alpha('H'))), left_tap());
    }

    #[test]
    fn comboing_other_keydown_releases_chord_drops_event() {
        // User does Space+D, then presses W without releasing D. We
        // emit D's release sequence (so D + modifiers don't stay
        // stuck) and drop the W press on the floor. User needs to
        // release D first to fire W's own combo — documented UX.
        let mut m = sm(SPACE_PTT);
        m.on_event(down(LogicalKey::Space));
        m.on_event(down(alpha('D'))); // enter Comboing(D)
        assert_eq!(
            m.on_event(down(alpha('W'))),
            emit(vec![
                SyntheticEvent::KeyUp(NamedKey::Alpha(b'D')),
                SyntheticEvent::ModifierUp(Modifier::Cmd),
                SyntheticEvent::ModifierUp(Modifier::Alt),
                SyntheticEvent::ModifierUp(Modifier::Ctrl),
            ])
        );
        // Now in Modifying { held: None }. User releases W and D
        // physically — both forwarded normally (no chord state).
        assert_eq!(m.on_event(up(alpha('W'))), Action::Forward);
        assert_eq!(m.on_event(up(alpha('D'))), Action::Forward);
        assert_eq!(m.on_event(up(LogicalKey::Space)), Action::Suppress);
    }

    #[test]
    fn comboing_suppresses_trigger_autorepeat() {
        // OS-driven autorepeat KeyDowns of the layer trigger (Space)
        // while a chord is held must NOT tear down the chord. They're
        // not real new presses, just kernel re-asserting the held key.
        let mut m = sm(SPACE_PTT);
        m.on_event(down(LogicalKey::Space));
        m.on_event(down(alpha('D')));
        assert_eq!(
            m.on_event(down_autorepeat(LogicalKey::Space)),
            Action::Suppress
        );
        // Chord state is still intact — D-up still emits the release.
        assert_eq!(
            m.on_event(up(alpha('D'))),
            emit(vec![
                SyntheticEvent::KeyUp(NamedKey::Alpha(b'D')),
                SyntheticEvent::ModifierUp(Modifier::Cmd),
                SyntheticEvent::ModifierUp(Modifier::Alt),
                SyntheticEvent::ModifierUp(Modifier::Ctrl),
            ])
        );
    }

    // Regression: user reported that with Runwa running, Warp's
    // Ctrl+Shift+R (history palette) worked only if Ctrl came first.
    // Shift first → CapsLock-as-Ctrl → R chained Shift+R, NOT
    // Ctrl+Shift+R. Cause: the Idle-trigger-down guard forwarded
    // CapsLock when an external modifier was held, treating it as
    // an OS-chord attempt — but CapsLock+anything isn't an OS chord.
    // Fix relaxes the guard for non-modifier triggers whose on_hold
    // is TransparentModifier, while also stamping `suppress_tap`
    // so the modifier-stack case doesn't ghost-emit on_tap.
    #[test]
    fn capslock_as_ctrl_stacks_with_held_shift() {
        let yaml = r#"
capslock:
  on_tap: [escape]
  on_hold: [ctrl]
"#;
        let mut m = sm(yaml);
        let mut shift = ModifierMask::EMPTY;
        shift.insert(Modifier::Shift);
        // Shift held when CapsLock comes down: enter Pending (not
        // Forward) so the Ctrl layer can fire on the next key.
        assert_eq!(
            m.on_event(down_with_mods(LogicalKey::CapsLock, shift)),
            Action::Suppress
        );
        // R press while CapsLock is pending: TransparentModifier(Ctrl)
        // path emits ModifierDown(Ctrl) and forwards R with the Ctrl
        // flag stamped. Combined with the held Shift, the app sees
        // Ctrl+Shift+R.
        assert_eq!(
            m.on_event(down_with_mods(alpha('R'), shift)),
            Action::EmitThenForwardWithModifiers(
                smallvec::smallvec![SyntheticEvent::ModifierDown(Modifier::Ctrl)],
                ModifierMask::just(Modifier::Ctrl),
            )
        );
        // CapsLock-up emits ModifierUp(Ctrl), returns to Idle.
        assert_eq!(
            m.on_event(up_with_mods(LogicalKey::CapsLock, shift)),
            emit(vec![SyntheticEvent::ModifierUp(Modifier::Ctrl)])
        );
    }

    // Same Ctrl+Shift+R intent, but Shift is ALSO configured as a
    // trigger in the user's yaml (`shift: on_tap: …`). The original
    // path: Shift down enters Pending(Shift) and suppresses the
    // physical KeyDown. CapsLock then arrives as an INTERRUPTION
    // of Shift's layer, not as a fresh trigger — so the Idle-arm
    // relaxation doesn't kick in. The fix widens the preempt arm
    // to fire when the new trigger's on_hold is a
    // TransparentModifier (CapsLock-as-Ctrl), so state hands off
    // from Pending(Shift) to Pending(CapsLock) and R goes through
    // CapsLock's Ctrl layer.
    #[test]
    fn shift_trigger_then_capslock_preempts_to_capslock_layer() {
        let yaml = r#"
shift:
  on_tap: [ctrl, alt, cmd, a]
capslock:
  on_tap: [escape]
  on_hold: [ctrl]
"#;
        let mut m = sm(yaml);
        // Shift physical KeyDown — own self-flag is set on the event. Goes
        // eager: the real Shift is injected now and stays held across the
        // preempt (balanced by the real Shift-up later).
        let mut shift_self = ModifierMask::EMPTY;
        shift_self.insert(Modifier::Shift);
        assert_eq!(
            m.on_event(down_with_mods(LogicalKey::Shift, shift_self)),
            emit(vec![SyntheticEvent::ModifierDown(Modifier::Shift)])
        );
        // CapsLock physical KeyDown while Shift is held — preempt to
        // CapsLock's layer instead of treating CapsLock as a shifted
        // interruption of Shift's layer.
        assert_eq!(
            m.on_event(down_with_mods(LogicalKey::CapsLock, shift_self)),
            Action::Suppress
        );
        // R arrives, still with Shift physically held. CapsLock's
        // TransparentModifier(Ctrl) fires — emit ModifierDown(Ctrl),
        // forward R with the Ctrl flag stamped. Combined with the
        // physically-held Shift, the receiving app sees Ctrl+Shift+R.
        assert_eq!(
            m.on_event(down_with_mods(alpha('R'), shift_self)),
            Action::EmitThenForwardWithModifiers(
                smallvec::smallvec![SyntheticEvent::ModifierDown(Modifier::Ctrl)],
                ModifierMask::just(Modifier::Ctrl),
            )
        );
        // Tear down: R-up → ForwardWithModifier(Ctrl).
        assert_eq!(
            m.on_event(up_with_mods(alpha('R'), shift_self)),
            Action::ForwardWithModifiers(ModifierMask::just(Modifier::Ctrl))
        );
        // CapsLock-up emits ModifierUp(Ctrl), back to Idle.
        assert_eq!(
            m.on_event(up_with_mods(LogicalKey::CapsLock, shift_self)),
            emit(vec![SyntheticEvent::ModifierUp(Modifier::Ctrl)])
        );
    }

    // Companion: if the user releases CapsLock WITHOUT pressing
    // anything else (so the Ctrl layer never had a chance to fire),
    // we must NOT emit CapsLock's on_tap (Escape) — that would
    // chord with the held Shift and the app would see Shift+Escape.
    #[test]
    fn capslock_tap_with_held_shift_suppresses_escape() {
        let yaml = r#"
capslock:
  on_tap: [escape]
  on_hold: [ctrl]
"#;
        let mut m = sm(yaml);
        let mut shift = ModifierMask::EMPTY;
        shift.insert(Modifier::Shift);
        assert_eq!(
            m.on_event(down_with_mods(LogicalKey::CapsLock, shift)),
            Action::Suppress
        );
        // CapsLock-up without an interrupting key: suppress the tap.
        assert_eq!(
            m.on_event(up_with_mods(LogicalKey::CapsLock, shift)),
            Action::Suppress
        );
    }
}
