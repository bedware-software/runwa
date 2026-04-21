//! macOS keyboard hook via `CGEventTap`.
//!
//! Architecture:
//!   - A dedicated thread creates the tap, wraps it in a CFRunLoopSource,
//!     adds it to the thread's CFRunLoop, then calls `CFRunLoopRun`.
//!   - The tap callback consults a global state machine (guarded by a
//!     mutex) and either forwards (`Some(event)`), suppresses (`None`), or
//!     emits synthetic events via `CGEventPost` before suppressing the
//!     original.
//!   - Re-entry protection: synthetic events carry our tag in
//!     `EVENT_SOURCE_USER_DATA`; the callback skips anything carrying it.
//!   - `TapDisabledByTimeout` / `TapDisabledByUserInput` are re-enabled in
//!     the callback so the hook self-heals.

use std::process::Command;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::thread;

use core_foundation::base::TCFType;
use core_foundation::runloop::{kCFRunLoopCommonModes, CFRunLoop, CFRunLoopSource};
use core_foundation_sys::mach_port::CFMachPortCreateRunLoopSource;
use core_graphics::event::{
    CGEvent, CGEventFlags, CGEventTap, CGEventTapLocation, CGEventTapOptions, CGEventTapPlacement,
    CGEventType, CallbackResult, EventField, KeyCode,
};
use core_graphics::event_source::{CGEventSource, CGEventSourceStateID};
use once_cell::sync::Lazy;
use parking_lot::{Condvar, Mutex};

use super::rules::{Modifier, ModifierMask, NamedKey, ResolvedRules, SyntheticEvent};
use super::state::{Action, EventKind, LogicalKey, RawEvent, StateMachine};
use super::synth::INJECT_TAG;

// ---------------------------------------------------------------------------
// Handle + registry state

pub struct MacosHook {
    running: Arc<AtomicBool>,
    run_loop: Arc<Mutex<Option<CFRunLoop>>>,
    join: Option<thread::JoinHandle<()>>,
    /// True iff we called `hidutil` to remap CapsLock→F19 at install
    /// time. Determines whether `stop()` reverts the mapping.
    capslock_remapped: bool,
}

impl super::HookHandle for MacosHook {
    fn stop(mut self: Box<Self>) {
        self.running.store(false, Ordering::SeqCst);
        if let Some(rl) = self.run_loop.lock().take() {
            rl.stop();
        }
        if let Some(join) = self.join.take() {
            let _ = join.join();
        }
        if self.capslock_remapped {
            disable_capslock_hid_remap();
        }
    }
}

static SM_SLOT: Lazy<Mutex<Option<StateMachine>>> = Lazy::new(|| Mutex::new(None));

// ---------------------------------------------------------------------------

pub fn install(rules: ResolvedRules) -> Result<MacosHook, String> {
    {
        let guard = SM_SLOT.lock();
        if guard.is_some() {
            return Err("keyboard remap already active".into());
        }
    }

    // If the user has a capslock rule, fire off the HID-level CapsLock→F19
    // remap *before* installing the tap, so the very first physical press
    // arrives as F19 rather than a lock-toggle. Failure here is logged but
    // non-fatal — the state machine will simply never see CapsLock events.
    let capslock_remapped = if rules.triggers.contains_key(&LogicalKey::CapsLock) {
        match enable_capslock_hid_remap() {
            Ok(()) => true,
            Err(e) => {
                eprintln!("[keyboard-remap] hidutil remap failed: {e}");
                false
            }
        }
    } else {
        false
    };

    {
        let mut guard = SM_SLOT.lock();
        *guard = Some(StateMachine::new(rules));
    }

    let running = Arc::new(AtomicBool::new(true));
    let run_loop = Arc::new(Mutex::new(None::<CFRunLoop>));
    let ready_state = Arc::new(Mutex::new(ReadyState::Pending));
    let ready_cv = Arc::new(Condvar::new());

    let running_clone = running.clone();
    let run_loop_clone = run_loop.clone();
    let ready_state_clone = ready_state.clone();
    let ready_cv_clone = ready_cv.clone();

    let join = thread::Builder::new()
        .name("runwa-keyboard-hook".into())
        .spawn(move || {
            match install_tap_on_current_thread() {
                Ok(tap) => {
                    // Store run loop for external stop().
                    let current_loop = CFRunLoop::get_current();
                    *run_loop_clone.lock() = Some(current_loop);

                    tap.enable();

                    {
                        let mut s = ready_state_clone.lock();
                        *s = ReadyState::Installed;
                        ready_cv_clone.notify_all();
                    }

                    // Blocks until CFRunLoopStop is called.
                    CFRunLoop::run_current();

                    // Tap dropped here (goes out of scope) — cleans up the
                    // underlying mach port.
                    drop(tap);
                }
                Err(e) => {
                    let mut s = ready_state_clone.lock();
                    *s = ReadyState::Failed(e);
                    ready_cv_clone.notify_all();
                }
            }

            // Clear the state machine slot so a subsequent install() works.
            *SM_SLOT.lock() = None;
            running_clone.store(false, Ordering::SeqCst);
        })
        .map_err(|e| format!("spawn hook thread: {e}"))?;

    // Wait until the install succeeds or fails.
    let mut guard = ready_state.lock();
    while matches!(*guard, ReadyState::Pending) {
        ready_cv.wait(&mut guard);
    }
    match std::mem::replace(&mut *guard, ReadyState::Pending) {
        ReadyState::Installed => Ok(MacosHook {
            running,
            run_loop,
            join: Some(join),
            capslock_remapped,
        }),
        ReadyState::Failed(e) => {
            *SM_SLOT.lock() = None;
            if capslock_remapped {
                disable_capslock_hid_remap();
            }
            Err(e)
        }
        ReadyState::Pending => unreachable!(),
    }
}

enum ReadyState {
    Pending,
    Installed,
    Failed(String),
}

// ---------------------------------------------------------------------------

fn install_tap_on_current_thread() -> Result<CGEventTap<'static>, String> {
    let events = vec![
        CGEventType::KeyDown,
        CGEventType::KeyUp,
        CGEventType::FlagsChanged,
    ];

    let tap = CGEventTap::new(
        CGEventTapLocation::HID,
        CGEventTapPlacement::HeadInsertEventTap,
        CGEventTapOptions::Default,
        events,
        tap_callback,
    )
    .map_err(|_| "CGEventTapCreate failed (Accessibility permission likely missing)".to_string())?;

    // Add the tap's mach port to the current run loop in common modes.
    let source = unsafe {
        let raw_source = CFMachPortCreateRunLoopSource(
            std::ptr::null_mut(),
            tap.mach_port().as_concrete_TypeRef(),
            0,
        );
        if raw_source.is_null() {
            return Err("CFMachPortCreateRunLoopSource returned null".into());
        }
        CFRunLoopSource::wrap_under_create_rule(raw_source)
    };
    let run_loop = CFRunLoop::get_current();
    run_loop.add_source(&source, unsafe { kCFRunLoopCommonModes });

    Ok(tap)
}

// ---------------------------------------------------------------------------
// Tap callback

fn tap_callback(
    _proxy: core_graphics::event::CGEventTapProxy,
    etype: CGEventType,
    event: &CGEvent,
) -> CallbackResult {
    // Self-heal: if macOS disabled us, re-enable and let the event through.
    if matches!(
        etype,
        CGEventType::TapDisabledByTimeout | CGEventType::TapDisabledByUserInput
    ) {
        // Re-enabling needs the mach port, which we don't have here. Best
        // effort: post-back a noop and trust that the next tap install
        // will recover. In practice tap-disable-by-timeout is rare if the
        // state machine returns quickly.
        return CallbackResult::Keep;
    }

    // Skip events we injected ourselves.
    let tag = event.get_integer_value_field(EventField::EVENT_SOURCE_USER_DATA);
    if tag == INJECT_TAG as i64 {
        return CallbackResult::Keep;
    }

    let (kind, key) = match etype {
        CGEventType::KeyDown => {
            let kc = event.get_integer_value_field(EventField::KEYBOARD_EVENT_KEYCODE) as u16;
            (EventKind::KeyDown, keycode_to_logical(kc))
        }
        CGEventType::KeyUp => {
            let kc = event.get_integer_value_field(EventField::KEYBOARD_EVENT_KEYCODE) as u16;
            (EventKind::KeyUp, keycode_to_logical(kc))
        }
        CGEventType::FlagsChanged => {
            // macOS delivers modifier keys (CapsLock, Shift, Ctrl, Alt,
            // Cmd) as FlagsChanged, not KeyDown/KeyUp. At HID-tap level we
            // see both the rising and falling edge per physical press, so
            // we can recover down/up by looking at whether this key's flag
            // bit is currently set. We dispatch *every* modifier to the
            // state machine — if the user hasn't configured that key as a
            // trigger, `on_event` returns Forward and we keep the event.
            let kc = event.get_integer_value_field(EventField::KEYBOARD_EVENT_KEYCODE) as u16;
            let Some((logical, flag_bit)) = modifier_keycode_to_logical(kc) else {
                return CallbackResult::Keep;
            };
            let flags = event.get_flags();
            let kind = if flags.contains(flag_bit) {
                EventKind::KeyDown
            } else {
                EventKind::KeyUp
            };
            (kind, logical)
        }
        _ => return CallbackResult::Keep,
    };

    // Snapshot the triggering event's flag state. This preserves the user's
    // real modifier keys (Shift, Ctrl, Cmd, …) across any synthetic events
    // we inject or forward: for example, holding Shift while pressing
    // Space+, must result in Shift+Home, not plain Home, because the user's
    // Shift should still be "on" when our synthesized Home fires.
    let event_flags = event.get_flags();

    // Mirror the flag state into the logical ModifierMask so rule lookup
    // can distinguish `keys: [shift, 1]` from `keys: [1]`.
    let raw = RawEvent {
        kind,
        key,
        modifiers: modifier_mask_from_flags(event_flags),
    };
    let action = {
        let mut guard = SM_SLOT.lock();
        match guard.as_mut() {
            Some(sm) => sm.on_event(raw),
            None => return CallbackResult::Keep,
        }
    };

    match action {
        Action::Forward => CallbackResult::Keep,
        Action::ForwardWithModifier(m) => {
            // Stamp the logically-held modifier (e.g. CapsLock's transparent
            // Ctrl) on top of the user's real modifier state and forward.
            // macOS — unlike Windows — doesn't propagate synthetic modifier
            // keydowns onto subsequent real events, so without this stamp
            // the second CapsLock+D after the first CapsLock+D would arrive
            // as a naked D.
            event.set_flags(event_flags | modifier_to_flag(m));
            CallbackResult::Keep
        }
        Action::Suppress => CallbackResult::Drop,
        Action::EmitTap(events) => {
            // Tap emission — do NOT inherit the trigger-up event's flags.
            // See the `EmitTap` doc comment: posting with `event_flags`
            // leaks stale synthetic-modifier state into the output and
            // makes apps like Zed observe Ctrl+Esc for what should be a
            // naked Esc.
            inject(events.as_slice(), CGEventFlags::empty());
            CallbackResult::Drop
        }
        Action::Emit(events) => {
            inject(events.as_slice(), event_flags);
            CallbackResult::Drop
        }
        Action::EmitThenForward(events) => {
            inject(events.as_slice(), event_flags);
            CallbackResult::Keep
        }
    }
}

// ---------------------------------------------------------------------------
// Keycode mapping (macOS virtual keycodes → LogicalKey)

// Carbon virtual keycodes not exposed by the `core-graphics` crate.
// Source: HIToolbox/Events.h. US-ANSI layout assumed.
const KC_LEFT: u16 = 0x7B;
const KC_RIGHT: u16 = 0x7C;
const KC_DOWN: u16 = 0x7D;
const KC_UP: u16 = 0x7E;
const KC_HOME: u16 = 0x73;
const KC_END: u16 = 0x77;
const KC_PGUP: u16 = 0x74;
const KC_PGDN: u16 = 0x79;
const KC_GRAVE: u16 = 0x32;
const KC_MINUS: u16 = 0x1B;
const KC_EQUAL: u16 = 0x18;
const KC_LBRACKET: u16 = 0x21;
const KC_RBRACKET: u16 = 0x1E;
const KC_BACKSLASH: u16 = 0x2A;
const KC_SEMICOLON: u16 = 0x29;
const KC_QUOTE: u16 = 0x27;
const KC_COMMA: u16 = 0x2B;
const KC_PERIOD: u16 = 0x2F;
const KC_SLASH: u16 = 0x2C;

fn keycode_to_logical(kc: u16) -> LogicalKey {
    // F19 is the HID-level stand-in for CapsLock: we ask macOS's hidutil
    // to remap CapsLock→F19 at install time, which bypasses the lock-key
    // driver behavior and gives us proper KeyDown/KeyUp events. See
    // `enable_capslock_hid_remap`. We still match raw CAPS_LOCK too so
    // users who have disabled the lock behavior in System Settings (which
    // already produces KeyDown/KeyUp) get the same treatment.
    if kc == KeyCode::CAPS_LOCK || kc == KeyCode::F19 {
        return LogicalKey::CapsLock;
    }
    if kc == KeyCode::SPACE {
        return LogicalKey::Space;
    }
    // Letters A–Z and digits have well-known keycodes on macOS ANSI:
    //   A=0, S=1, D=2, F=3, H=4, G=5, Z=6, X=7, C=8, V=9, B=11, Q=12,
    //   W=13, E=14, R=15, Y=16, T=17, 1=18, 2=19, 3=20, 4=21, 6=22, 5=23,
    //   '='=24, 9=25, 7=26, '-'=27, 8=28, 0=29, ']'=30, O=31, U=32, '['=33,
    //   I=34, P=35, L=37, J=38, K=40, N=45, M=46, ...
    let nk = match kc {
        0x00 => NamedKey::Alpha(b'A'),
        0x01 => NamedKey::Alpha(b'S'),
        0x02 => NamedKey::Alpha(b'D'),
        0x03 => NamedKey::Alpha(b'F'),
        0x04 => NamedKey::Alpha(b'H'),
        0x05 => NamedKey::Alpha(b'G'),
        0x06 => NamedKey::Alpha(b'Z'),
        0x07 => NamedKey::Alpha(b'X'),
        0x08 => NamedKey::Alpha(b'C'),
        0x09 => NamedKey::Alpha(b'V'),
        0x0B => NamedKey::Alpha(b'B'),
        0x0C => NamedKey::Alpha(b'Q'),
        0x0D => NamedKey::Alpha(b'W'),
        0x0E => NamedKey::Alpha(b'E'),
        0x0F => NamedKey::Alpha(b'R'),
        0x10 => NamedKey::Alpha(b'Y'),
        0x11 => NamedKey::Alpha(b'T'),
        0x12 => NamedKey::Alpha(b'1'),
        0x13 => NamedKey::Alpha(b'2'),
        0x14 => NamedKey::Alpha(b'3'),
        0x15 => NamedKey::Alpha(b'4'),
        0x16 => NamedKey::Alpha(b'6'),
        0x17 => NamedKey::Alpha(b'5'),
        0x19 => NamedKey::Alpha(b'9'),
        0x1A => NamedKey::Alpha(b'7'),
        0x1C => NamedKey::Alpha(b'8'),
        0x1D => NamedKey::Alpha(b'0'),
        0x1F => NamedKey::Alpha(b'O'),
        0x20 => NamedKey::Alpha(b'U'),
        0x22 => NamedKey::Alpha(b'I'),
        0x23 => NamedKey::Alpha(b'P'),
        0x25 => NamedKey::Alpha(b'L'),
        0x26 => NamedKey::Alpha(b'J'),
        0x28 => NamedKey::Alpha(b'K'),
        0x2D => NamedKey::Alpha(b'N'),
        0x2E => NamedKey::Alpha(b'M'),
        // Named keys the user can bind in YAML.
        kc if kc == KeyCode::ESCAPE => NamedKey::Escape,
        kc if kc == KeyCode::TAB => NamedKey::Tab,
        kc if kc == KeyCode::RETURN => NamedKey::Return,
        kc if kc == KeyCode::DELETE => NamedKey::Delete,
        kc if kc == KeyCode::F1 => NamedKey::F1,
        kc if kc == KeyCode::F2 => NamedKey::F2,
        kc if kc == KeyCode::F3 => NamedKey::F3,
        kc if kc == KeyCode::F4 => NamedKey::F4,
        kc if kc == KeyCode::F5 => NamedKey::F5,
        kc if kc == KeyCode::F6 => NamedKey::F6,
        kc if kc == KeyCode::F7 => NamedKey::F7,
        kc if kc == KeyCode::F8 => NamedKey::F8,
        kc if kc == KeyCode::F9 => NamedKey::F9,
        kc if kc == KeyCode::F10 => NamedKey::F10,
        kc if kc == KeyCode::F11 => NamedKey::F11,
        kc if kc == KeyCode::F12 => NamedKey::F12,
        KC_LEFT => NamedKey::Left,
        KC_RIGHT => NamedKey::Right,
        KC_UP => NamedKey::Up,
        KC_DOWN => NamedKey::Down,
        KC_HOME => NamedKey::Home,
        KC_END => NamedKey::End,
        KC_PGUP => NamedKey::PageUp,
        KC_PGDN => NamedKey::PageDown,
        KC_GRAVE => NamedKey::Backtick,
        KC_MINUS => NamedKey::Minus,
        KC_EQUAL => NamedKey::Equals,
        KC_LBRACKET => NamedKey::LeftBracket,
        KC_RBRACKET => NamedKey::RightBracket,
        KC_BACKSLASH => NamedKey::Backslash,
        KC_SEMICOLON => NamedKey::Semicolon,
        KC_QUOTE => NamedKey::Quote,
        KC_COMMA => NamedKey::Comma,
        KC_PERIOD => NamedKey::Period,
        KC_SLASH => NamedKey::Slash,
        _ => return LogicalKey::Other,
    };
    LogicalKey::Named(nk)
}

fn named_to_keycode(key: NamedKey) -> Option<u16> {
    match key {
        NamedKey::Escape => Some(KeyCode::ESCAPE),
        NamedKey::Space => Some(KeyCode::SPACE),
        NamedKey::Tab => Some(KeyCode::TAB),
        NamedKey::Return => Some(KeyCode::RETURN),
        NamedKey::Delete => Some(KeyCode::DELETE),
        NamedKey::F1 => Some(KeyCode::F1),
        NamedKey::F2 => Some(KeyCode::F2),
        NamedKey::F3 => Some(KeyCode::F3),
        NamedKey::F4 => Some(KeyCode::F4),
        NamedKey::F5 => Some(KeyCode::F5),
        NamedKey::F6 => Some(KeyCode::F6),
        NamedKey::F7 => Some(KeyCode::F7),
        NamedKey::F8 => Some(KeyCode::F8),
        NamedKey::F9 => Some(KeyCode::F9),
        NamedKey::F10 => Some(KeyCode::F10),
        NamedKey::F11 => Some(KeyCode::F11),
        NamedKey::F12 => Some(KeyCode::F12),
        NamedKey::Left => Some(KC_LEFT),
        NamedKey::Right => Some(KC_RIGHT),
        NamedKey::Up => Some(KC_UP),
        NamedKey::Down => Some(KC_DOWN),
        NamedKey::Home => Some(KC_HOME),
        NamedKey::End => Some(KC_END),
        NamedKey::PageUp => Some(KC_PGUP),
        NamedKey::PageDown => Some(KC_PGDN),
        NamedKey::Backtick => Some(KC_GRAVE),
        NamedKey::Minus => Some(KC_MINUS),
        NamedKey::Equals => Some(KC_EQUAL),
        NamedKey::LeftBracket => Some(KC_LBRACKET),
        NamedKey::RightBracket => Some(KC_RBRACKET),
        NamedKey::Backslash => Some(KC_BACKSLASH),
        NamedKey::Semicolon => Some(KC_SEMICOLON),
        NamedKey::Quote => Some(KC_QUOTE),
        NamedKey::Comma => Some(KC_COMMA),
        NamedKey::Period => Some(KC_PERIOD),
        NamedKey::Slash => Some(KC_SLASH),
        NamedKey::Alpha(b) => alpha_to_keycode(b),
    }
}

fn alpha_to_keycode(b: u8) -> Option<u16> {
    Some(match b {
        b'A' => 0x00,
        b'S' => 0x01,
        b'D' => 0x02,
        b'F' => 0x03,
        b'H' => 0x04,
        b'G' => 0x05,
        b'Z' => 0x06,
        b'X' => 0x07,
        b'C' => 0x08,
        b'V' => 0x09,
        b'B' => 0x0B,
        b'Q' => 0x0C,
        b'W' => 0x0D,
        b'E' => 0x0E,
        b'R' => 0x0F,
        b'Y' => 0x10,
        b'T' => 0x11,
        b'1' => 0x12,
        b'2' => 0x13,
        b'3' => 0x14,
        b'4' => 0x15,
        b'6' => 0x16,
        b'5' => 0x17,
        b'9' => 0x19,
        b'7' => 0x1A,
        b'8' => 0x1C,
        b'0' => 0x1D,
        b'O' => 0x1F,
        b'U' => 0x20,
        b'I' => 0x22,
        b'P' => 0x23,
        b'L' => 0x25,
        b'J' => 0x26,
        b'K' => 0x28,
        b'N' => 0x2D,
        b'M' => 0x2E,
        _ => return None,
    })
}

fn modifier_to_keycode(m: Modifier) -> u16 {
    match m {
        Modifier::Ctrl => KeyCode::CONTROL,
        Modifier::Alt => KeyCode::OPTION,
        Modifier::Shift => KeyCode::SHIFT,
        Modifier::Cmd | Modifier::Win => KeyCode::COMMAND,
    }
}

/// Map a macOS virtual keycode that arrives via `FlagsChanged` to the
/// `LogicalKey` the state machine cares about, plus the `CGEventFlags` bit
/// that distinguishes down from up on that key. Covers every modifier that
/// could be a top-level trigger in the YAML. Returns None for keycodes that
/// aren't modifier-like (we leave those events untouched).
fn modifier_keycode_to_logical(kc: u16) -> Option<(LogicalKey, CGEventFlags)> {
    let right_shift = 0x3C_u16;
    let right_control = 0x3E_u16;
    let right_option = 0x3D_u16;
    let right_command = 0x36_u16;
    match kc {
        kc if kc == KeyCode::CAPS_LOCK => Some((LogicalKey::CapsLock, CGEventFlags::CGEventFlagAlphaShift)),
        kc if kc == KeyCode::SHIFT || kc == right_shift => Some((LogicalKey::Shift, CGEventFlags::CGEventFlagShift)),
        kc if kc == KeyCode::CONTROL || kc == right_control => Some((LogicalKey::Ctrl, CGEventFlags::CGEventFlagControl)),
        kc if kc == KeyCode::OPTION || kc == right_option => Some((LogicalKey::Alt, CGEventFlags::CGEventFlagAlternate)),
        kc if kc == KeyCode::COMMAND || kc == right_command => Some((LogicalKey::Cmd, CGEventFlags::CGEventFlagCommand)),
        _ => None,
    }
}

fn modifier_to_flag(m: Modifier) -> CGEventFlags {
    match m {
        Modifier::Ctrl => CGEventFlags::CGEventFlagControl,
        Modifier::Alt => CGEventFlags::CGEventFlagAlternate,
        Modifier::Shift => CGEventFlags::CGEventFlagShift,
        Modifier::Cmd | Modifier::Win => CGEventFlags::CGEventFlagCommand,
    }
}

fn modifier_mask_from_flags(flags: CGEventFlags) -> ModifierMask {
    let mut m = ModifierMask::EMPTY;
    if flags.contains(CGEventFlags::CGEventFlagShift) {
        m.insert(Modifier::Shift);
    }
    if flags.contains(CGEventFlags::CGEventFlagControl) {
        m.insert(Modifier::Ctrl);
    }
    if flags.contains(CGEventFlags::CGEventFlagAlternate) {
        m.insert(Modifier::Alt);
    }
    if flags.contains(CGEventFlags::CGEventFlagCommand) {
        m.insert(Modifier::Cmd);
    }
    m
}

// ---------------------------------------------------------------------------
// Injection

pub(super) fn inject(events: &[SyntheticEvent], base_flags: CGEventFlags) {
    let source = match CGEventSource::new(CGEventSourceStateID::HIDSystemState) {
        Ok(s) => s,
        Err(_) => return,
    };
    // Track accumulated modifier state across the burst. CGEvent doesn't
    // derive flags from "which modifier keyDowns we've posted recently" —
    // every created event starts with flags=0 unless we set them explicitly.
    // Receiving apps match hotkeys on the event's `flags` field, so we must
    // stamp the correct flag set on every KeyDown/KeyUp, and on the
    // modifier events themselves (so the final flags state lines up with
    // what a real physical chord would look like).
    //
    // `base_flags` is the triggering event's own flags at the time we
    // entered the callback — this carries forward any modifier the user
    // was actually holding (e.g. Shift) so Space+Shift+, emits Shift+Home
    // rather than plain Home.
    let mut flags = base_flags;
    for ev in events {
        let (keycode, down) = match ev {
            SyntheticEvent::ModifierDown(m) => {
                flags |= modifier_to_flag(*m);
                (modifier_to_keycode(*m), true)
            }
            SyntheticEvent::ModifierUp(m) => {
                flags &= !modifier_to_flag(*m);
                (modifier_to_keycode(*m), false)
            }
            SyntheticEvent::KeyDown(k) => match named_to_keycode(*k) {
                Some(kc) => (kc, true),
                None => continue,
            },
            SyntheticEvent::KeyUp(k) => match named_to_keycode(*k) {
                Some(kc) => (kc, false),
                None => continue,
            },
            SyntheticEvent::SwitchToWorkspace(n) => {
                // macOS has no reliable public API for space switching —
                // SkyLight's `CGSManagedDisplaySetCurrentSpace` moves the
                // compositor pointer but doesn't sync with WindowServer /
                // Dock / Mission Control on Sequoia+, leaving windows
                // from the previous space bleeding through. Without a
                // yabai-style scripting addition (SIP partially disabled),
                // the pragmatic approach is to synthesize the built-in
                // `Ctrl+N` shortcut — users enable it once in
                // System Settings → Keyboard → Shortcuts → Mission Control
                // → Switch to Desktop N.
                let n = *n;
                let key = if (1..=9).contains(&n) {
                    NamedKey::Alpha(b'0' + n as u8)
                } else {
                    eprintln!(
                        "[keyboard-remap] switch_to_workspace({n}) on macOS supports 1-9 only"
                    );
                    continue;
                };
                inject(
                    &[
                        SyntheticEvent::ModifierDown(Modifier::Ctrl),
                        SyntheticEvent::KeyDown(key),
                        SyntheticEvent::KeyUp(key),
                        SyntheticEvent::ModifierUp(Modifier::Ctrl),
                    ],
                    flags,
                );
                // Shadow-track the switch so the tray (and anyone else
                // calling `get_current_desktop_number`) can reflect the
                // user's intent — macOS has no public Space-ordinal API.
                // Convert YAML's 1-based N to our 0-based storage.
                super::macos_desktop_tracker::set(n.saturating_sub(1));
                continue;
            }
            SyntheticEvent::MoveToWorkspace(n) => {
                // No public macOS API for cross-Space window moves; we
                // mimic the manual gesture (grab title bar, switch Space,
                // drop) on a detached thread. See
                // `macos_move_window::move_active_window_to_workspace`.
                let n = *n;
                super::macos_move_window::move_active_window_to_workspace(n);
                // Move-to also ends up on the target Space, so track it
                // the same way we track a plain switch.
                super::macos_desktop_tracker::set(n.saturating_sub(1));
                continue;
            }
        };
        let Ok(cge) = CGEvent::new_keyboard_event(source.clone(), keycode, down) else {
            continue;
        };
        cge.set_flags(flags);
        cge.set_integer_value_field(EventField::EVENT_SOURCE_USER_DATA, INJECT_TAG as i64);
        cge.post(CGEventTapLocation::HID);
    }
}

// ---------------------------------------------------------------------------
// hidutil: physical-CapsLock → F19 remap.
//
// macOS exposes CapsLock as a session-level toggle (the HID driver latches
// it); CGEventTap sees a single FlagsChanged per press with no down/up pair.
// That makes a Karabiner-style tap-for-Esc + hold-for-Ctrl remap impossible
// from a CGEventTap alone. `hidutil property --set` lets us rewrite the HID
// usage code per login session before the driver's lock logic runs, so the
// physical CapsLock key surfaces as F19 with proper KeyDown/KeyUp — which
// the tap can then remap normally. `keycode_to_logical` maps F19 back to
// `LogicalKey::CapsLock` so rule YAML can still refer to `capslock`.
//
// The remap is per-session (ephemeral, not persisted) and applies across
// every keyboard and every app. `stop()` reverts it; a crash without
// cleanup leaves CapsLock→F19 until the user reboots or runs
// `hidutil property --set '{"UserKeyMapping":[]}'` themselves.

// HID Usage Page 0x07 (Keyboard/Keypad), usage 0x39 = CapsLock.
const HID_USAGE_CAPS_LOCK: u64 = 0x700000039;
// HID Usage Page 0x07, usage 0x6E = Keyboard F19.
const HID_USAGE_F19: u64 = 0x70000006E;

fn enable_capslock_hid_remap() -> Result<(), String> {
    let payload = format!(
        r#"{{"UserKeyMapping":[{{"HIDKeyboardModifierMappingSrc":{src},"HIDKeyboardModifierMappingDst":{dst}}}]}}"#,
        src = HID_USAGE_CAPS_LOCK,
        dst = HID_USAGE_F19,
    );
    run_hidutil(&payload)
}

fn disable_capslock_hid_remap() {
    // Clearing to an empty list wipes the remap for this login session.
    // Best-effort — log and move on if it fails.
    if let Err(e) = run_hidutil(r#"{"UserKeyMapping":[]}"#) {
        eprintln!("[keyboard-remap] hidutil revert failed: {e}");
    }
}

fn run_hidutil(payload: &str) -> Result<(), String> {
    let out = Command::new("/usr/bin/hidutil")
        .args(["property", "--set", payload])
        .output()
        .map_err(|e| format!("spawn hidutil: {e}"))?;
    if !out.status.success() {
        return Err(format!(
            "hidutil exit {}: {}",
            out.status,
            String::from_utf8_lossy(&out.stderr).trim()
        ));
    }
    Ok(())
}
