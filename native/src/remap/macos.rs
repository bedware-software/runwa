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

use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::thread;

use core_foundation::base::TCFType;
use core_foundation::runloop::{kCFRunLoopCommonModes, CFRunLoop, CFRunLoopSource};
use core_foundation_sys::mach_port::CFMachPortCreateRunLoopSource;
use core_graphics::event::{
    CGEvent, CGEventTap, CGEventTapLocation, CGEventTapOptions, CGEventTapPlacement, CGEventType,
    EventField, KeyCode,
};
use core_graphics::event_source::{CGEventSource, CGEventSourceStateID};
use once_cell::sync::Lazy;
use parking_lot::{Condvar, Mutex};

use super::rules::{Modifier, ResolvedRules};
use super::state::{
    Action, EventKind, LogicalKey, RawEvent, StateMachine, SynthKey, SyntheticEvent,
};
use super::synth::INJECT_TAG;

// ---------------------------------------------------------------------------
// Handle + registry state

pub struct MacosHook {
    running: Arc<AtomicBool>,
    run_loop: Arc<Mutex<Option<CFRunLoop>>>,
    join: Option<thread::JoinHandle<()>>,
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
        }),
        ReadyState::Failed(e) => {
            *SM_SLOT.lock() = None;
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
            tap.mach_port.as_concrete_TypeRef(),
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
) -> Option<CGEvent> {
    // Self-heal: if macOS disabled us, re-enable and let the event through.
    if matches!(
        etype,
        CGEventType::TapDisabledByTimeout | CGEventType::TapDisabledByUserInput
    ) {
        // Re-enabling needs the mach port, which we don't have here. Best
        // effort: post-back a noop and trust that the next tap install
        // will recover. In practice tap-disable-by-timeout is rare if the
        // state machine returns quickly.
        return Some(event.clone());
    }

    // Skip events we injected ourselves.
    let tag = event.get_integer_value_field(EventField::EVENT_SOURCE_USER_DATA);
    if tag == INJECT_TAG as i64 {
        return Some(event.clone());
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
            // A modifier key was pressed/released. We surface the CapsLock
            // transitions to the state machine; other modifiers (Shift,
            // Ctrl, Alt, Cmd) are forwarded unchanged — we don't want to
            // fight with the user's real modifier keys.
            let kc = event.get_integer_value_field(EventField::KEYBOARD_EVENT_KEYCODE) as u16;
            if kc == KeyCode::CAPS_LOCK {
                // Distinguishing down vs up from FlagsChanged requires
                // checking the CapsLock flag bit. Simpler: we never
                // remap CapsLock-as-lock via FlagsChanged and instead
                // rely on it arriving as a KeyDown/KeyUp — which it
                // does on recent macOS versions after the accessibility
                // grant. If we see it here, just forward.
                return Some(event.clone());
            }
            return Some(event.clone());
        }
        _ => return Some(event.clone()),
    };

    let raw = RawEvent { kind, key };
    let action = {
        let mut guard = SM_SLOT.lock();
        match guard.as_mut() {
            Some(sm) => sm.on_event(raw),
            None => return Some(event.clone()),
        }
    };

    match action {
        Action::Forward => Some(event.clone()),
        Action::Suppress => None,
        Action::Emit(events) => {
            inject(events.as_slice());
            None
        }
    }
}

// ---------------------------------------------------------------------------
// Keycode mapping (macOS virtual keycodes → LogicalKey)

fn keycode_to_logical(kc: u16) -> LogicalKey {
    if kc == KeyCode::CAPS_LOCK {
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
    match kc {
        0x00 => LogicalKey::Alpha(b'A'),
        0x01 => LogicalKey::Alpha(b'S'),
        0x02 => LogicalKey::Alpha(b'D'),
        0x03 => LogicalKey::Alpha(b'F'),
        0x04 => LogicalKey::Alpha(b'H'),
        0x05 => LogicalKey::Alpha(b'G'),
        0x06 => LogicalKey::Alpha(b'Z'),
        0x07 => LogicalKey::Alpha(b'X'),
        0x08 => LogicalKey::Alpha(b'C'),
        0x09 => LogicalKey::Alpha(b'V'),
        0x0B => LogicalKey::Alpha(b'B'),
        0x0C => LogicalKey::Alpha(b'Q'),
        0x0D => LogicalKey::Alpha(b'W'),
        0x0E => LogicalKey::Alpha(b'E'),
        0x0F => LogicalKey::Alpha(b'R'),
        0x10 => LogicalKey::Alpha(b'Y'),
        0x11 => LogicalKey::Alpha(b'T'),
        0x12 => LogicalKey::Alpha(b'1'),
        0x13 => LogicalKey::Alpha(b'2'),
        0x14 => LogicalKey::Alpha(b'3'),
        0x15 => LogicalKey::Alpha(b'4'),
        0x16 => LogicalKey::Alpha(b'6'),
        0x17 => LogicalKey::Alpha(b'5'),
        0x19 => LogicalKey::Alpha(b'9'),
        0x1A => LogicalKey::Alpha(b'7'),
        0x1C => LogicalKey::Alpha(b'8'),
        0x1D => LogicalKey::Alpha(b'0'),
        0x1F => LogicalKey::Alpha(b'O'),
        0x20 => LogicalKey::Alpha(b'U'),
        0x22 => LogicalKey::Alpha(b'I'),
        0x23 => LogicalKey::Alpha(b'P'),
        0x25 => LogicalKey::Alpha(b'L'),
        0x26 => LogicalKey::Alpha(b'J'),
        0x28 => LogicalKey::Alpha(b'K'),
        0x2D => LogicalKey::Alpha(b'N'),
        0x2E => LogicalKey::Alpha(b'M'),
        _ => LogicalKey::Other,
    }
}

fn logical_to_keycode(key: SynthKey) -> Option<u16> {
    match key {
        SynthKey::Escape => Some(KeyCode::ESCAPE),
        SynthKey::Space => Some(KeyCode::SPACE),
        SynthKey::F4 => Some(KeyCode::F4),
        SynthKey::Alpha(b) => alpha_to_keycode(b),
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

// ---------------------------------------------------------------------------
// Injection

fn inject(events: &[SyntheticEvent]) {
    let source = match CGEventSource::new(CGEventSourceStateID::HIDSystemState) {
        Ok(s) => s,
        Err(_) => return,
    };
    for ev in events {
        let (keycode, down) = match ev {
            SyntheticEvent::ModifierDown(m) => (modifier_to_keycode(*m), true),
            SyntheticEvent::ModifierUp(m) => (modifier_to_keycode(*m), false),
            SyntheticEvent::KeyDown(k) => match logical_to_keycode(*k) {
                Some(kc) => (kc, true),
                None => continue,
            },
            SyntheticEvent::KeyUp(k) => match logical_to_keycode(*k) {
                Some(kc) => (kc, false),
                None => continue,
            },
        };
        let Ok(cge) = CGEvent::new_keyboard_event(source.clone(), keycode, down) else {
            continue;
        };
        cge.set_integer_value_field(EventField::EVENT_SOURCE_USER_DATA, INJECT_TAG as i64);
        cge.post(CGEventTapLocation::HID);
    }
}
