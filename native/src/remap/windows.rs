//! Windows low-level keyboard hook.
//!
//! Architecture:
//!   - A dedicated thread installs `WH_KEYBOARD_LL`, then runs a
//!     `GetMessageW` pump. The hook proc bounces to a thread-local state
//!     machine guarded by a mutex.
//!   - Teardown posts `WM_QUIT` to the hook thread, which drops out of the
//!     message loop, calls `UnhookWindowsHookEx`, and exits.
//!   - All synthetic events go through `SendInput` with
//!     `dwExtraInfo = INJECT_TAG`. The hook skips anything carrying that
//!     tag, so we don't re-enter ourselves.
//!
//! The LL hook runs on the thread that installed it; `LowLevelHooksTimeout`
//! (default 300ms) will force Windows to skip the hook if the callback
//! blocks, so the state machine path must stay allocation-light and lock
//! durations must be short.

use std::sync::atomic::{AtomicBool, AtomicU32, Ordering};
use std::sync::Arc;
use std::thread;

use parking_lot::Mutex;
use smallvec::SmallVec;
use windows::Win32::Foundation::{LPARAM, LRESULT, WPARAM};
use windows::Win32::UI::Input::KeyboardAndMouse::{
    SendInput, INPUT, INPUT_0, INPUT_KEYBOARD, KEYBDINPUT, KEYEVENTF_KEYUP, VIRTUAL_KEY,
    VK_CAPITAL, VK_ESCAPE, VK_F4, VK_LCONTROL, VK_LMENU, VK_LSHIFT, VK_LWIN, VK_SPACE,
};
use windows::Win32::UI::WindowsAndMessaging::{
    CallNextHookEx, DispatchMessageW, GetMessageW, PostThreadMessageW, SetWindowsHookExW,
    TranslateMessage, UnhookWindowsHookEx, HHOOK, KBDLLHOOKSTRUCT, LLKHF_INJECTED, MSG,
    WH_KEYBOARD_LL, WM_KEYDOWN, WM_KEYUP, WM_QUIT, WM_SYSKEYDOWN, WM_SYSKEYUP,
};

use super::rules::{Modifier, NamedKey, ResolvedRules, SyntheticEvent};
use super::state::{Action, EventKind, LogicalKey, RawEvent, StateMachine};
use super::synth::INJECT_TAG;

/// Handle owned by the registry. Dropping via `HookHandle::stop` posts
/// `WM_QUIT` and joins the hook thread.
pub struct WindowsHook {
    thread_id: Arc<AtomicU32>,
    running: Arc<AtomicBool>,
    join: Option<thread::JoinHandle<()>>,
}

impl super::HookHandle for WindowsHook {
    fn stop(mut self: Box<Self>) {
        let tid = self.thread_id.load(Ordering::SeqCst);
        self.running.store(false, Ordering::SeqCst);
        if tid != 0 {
            unsafe {
                let _ = PostThreadMessageW(tid, WM_QUIT, WPARAM(0), LPARAM(0));
            }
        }
        if let Some(join) = self.join.take() {
            let _ = join.join();
        }
    }
}

// ---------------------------------------------------------------------------
// Global state — one active hook per process (LL keyboard hooks are global
// anyway, stacking multiple wouldn't help).

static HOOK_SLOT: once_cell::sync::Lazy<Mutex<Option<ActiveHook>>> =
    once_cell::sync::Lazy::new(|| Mutex::new(None));

struct ActiveHook {
    hhook: HHOOK,
    sm: StateMachine,
}

// HHOOK is a `*mut c_void` wrapper. The hook is installed on and torn down
// from a single dedicated thread, so the raw pointer never crosses into
// concurrent use — it's safe to hold in a statically-shared Mutex.
unsafe impl Send for ActiveHook {}
unsafe impl Sync for ActiveHook {}

// ---------------------------------------------------------------------------

pub fn install(rules: ResolvedRules) -> Result<WindowsHook, String> {
    // Prevent multiple concurrent installs.
    {
        let guard = HOOK_SLOT.lock();
        if guard.is_some() {
            return Err("keyboard remap already active".into());
        }
    }

    let thread_id = Arc::new(AtomicU32::new(0));
    let running = Arc::new(AtomicBool::new(true));
    let ready_tx = Arc::new(parking_lot::Condvar::new());
    let ready_state = Arc::new(Mutex::new(ReadyState::Pending));

    let tid_clone = thread_id.clone();
    let running_clone = running.clone();
    let ready_tx_clone = ready_tx.clone();
    let ready_state_clone = ready_state.clone();

    let rules_for_thread = rules;

    let join = thread::Builder::new()
        .name("runwa-keyboard-hook".into())
        .spawn(move || unsafe {
            use windows::Win32::System::Threading::GetCurrentThreadId;

            tid_clone.store(GetCurrentThreadId(), Ordering::SeqCst);

            let hhook = match SetWindowsHookExW(WH_KEYBOARD_LL, Some(ll_proc), None, 0) {
                Ok(h) => h,
                Err(err) => {
                    let mut s = ready_state_clone.lock();
                    *s = ReadyState::Failed(format!("SetWindowsHookExW: {err}"));
                    ready_tx_clone.notify_all();
                    return;
                }
            };

            {
                let mut slot = HOOK_SLOT.lock();
                *slot = Some(ActiveHook {
                    hhook,
                    sm: StateMachine::new(rules_for_thread),
                });
            }

            {
                let mut s = ready_state_clone.lock();
                *s = ReadyState::Installed;
                ready_tx_clone.notify_all();
            }

            // Standard modal loop. `WM_QUIT` (posted by `stop`) makes
            // `GetMessageW` return 0.
            let mut msg: MSG = std::mem::zeroed();
            while running_clone.load(Ordering::SeqCst) {
                let got = GetMessageW(&mut msg, None, 0, 0);
                if got.0 <= 0 {
                    break;
                }
                let _ = TranslateMessage(&msg);
                DispatchMessageW(&msg);
            }

            // Teardown.
            let _ = UnhookWindowsHookEx(hhook);
            let mut slot = HOOK_SLOT.lock();
            *slot = None;
        })
        .map_err(|e| format!("spawn hook thread: {e}"))?;

    // Wait until the hook thread reports success or failure.
    let mut guard = ready_state.lock();
    while matches!(*guard, ReadyState::Pending) {
        ready_tx.wait(&mut guard);
    }
    match std::mem::replace(&mut *guard, ReadyState::Pending) {
        ReadyState::Installed => Ok(WindowsHook {
            thread_id,
            running,
            join: Some(join),
        }),
        ReadyState::Failed(e) => {
            running.store(false, Ordering::SeqCst);
            // Thread will exit on its own.
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
// LL hook procedure.

unsafe extern "system" fn ll_proc(code: i32, wparam: WPARAM, lparam: LPARAM) -> LRESULT {
    if code < 0 {
        return CallNextHookEx(None, code, wparam, lparam);
    }

    let info = &*(lparam.0 as *const KBDLLHOOKSTRUCT);

    // Skip events we injected ourselves.
    if (info.flags.0 & LLKHF_INJECTED.0) != 0 && info.dwExtraInfo == INJECT_TAG {
        return CallNextHookEx(None, code, wparam, lparam);
    }

    let kind = match wparam.0 as u32 {
        WM_KEYDOWN | WM_SYSKEYDOWN => EventKind::KeyDown,
        WM_KEYUP | WM_SYSKEYUP => EventKind::KeyUp,
        _ => return CallNextHookEx(None, code, wparam, lparam),
    };

    let key = vk_to_logical(info.vkCode);
    let ev = RawEvent { kind, key };

    // Short critical section: only hold while calling the state machine.
    let action = {
        let mut slot = HOOK_SLOT.lock();
        match slot.as_mut() {
            Some(active) => active.sm.on_event(ev),
            None => return CallNextHookEx(None, code, wparam, lparam),
        }
    };

    match action {
        Action::Forward => CallNextHookEx(None, code, wparam, lparam),
        Action::Suppress => LRESULT(1),
        Action::Emit(events) => {
            // Inject all events synchronously. SendInput runs fast and
            // enqueues the events — the injected events will re-enter this
            // hook with the INJECT_TAG and be skipped.
            inject(events.as_slice());
            LRESULT(1)
        }
    }
}

// ---------------------------------------------------------------------------
// Mapping from Windows VK codes to logical keys.

fn vk_to_logical(vk: u32) -> LogicalKey {
    const VK_A: u32 = 0x41;
    const VK_Z: u32 = 0x5A;
    const VK_0: u32 = 0x30;
    const VK_9: u32 = 0x39;
    if vk == VK_CAPITAL.0 as u32 {
        LogicalKey::CapsLock
    } else if vk == VK_SPACE.0 as u32 {
        LogicalKey::Space
    } else if (VK_A..=VK_Z).contains(&vk) {
        LogicalKey::Alpha((b'A' + (vk - VK_A) as u8) as u8)
    } else if (VK_0..=VK_9).contains(&vk) {
        LogicalKey::Alpha((b'0' + (vk - VK_0) as u8) as u8)
    } else {
        LogicalKey::Other
    }
}

fn named_to_vk(key: NamedKey) -> VIRTUAL_KEY {
    use windows::Win32::UI::Input::KeyboardAndMouse::{
        VK_BACK, VK_F1, VK_F10, VK_F11, VK_F12, VK_F2, VK_F3, VK_F5, VK_F6, VK_F7, VK_F8, VK_F9,
        VK_RETURN, VK_TAB,
    };
    match key {
        NamedKey::Escape => VK_ESCAPE,
        NamedKey::Space => VK_SPACE,
        NamedKey::Tab => VK_TAB,
        NamedKey::Return => VK_RETURN,
        NamedKey::Delete => VK_BACK,
        NamedKey::F1 => VK_F1,
        NamedKey::F2 => VK_F2,
        NamedKey::F3 => VK_F3,
        NamedKey::F4 => VK_F4,
        NamedKey::F5 => VK_F5,
        NamedKey::F6 => VK_F6,
        NamedKey::F7 => VK_F7,
        NamedKey::F8 => VK_F8,
        NamedKey::F9 => VK_F9,
        NamedKey::F10 => VK_F10,
        NamedKey::F11 => VK_F11,
        NamedKey::F12 => VK_F12,
        NamedKey::Alpha(b) => VIRTUAL_KEY(b as u16),
    }
}

fn modifier_to_vk(m: Modifier) -> VIRTUAL_KEY {
    match m {
        Modifier::Ctrl => VK_LCONTROL,
        Modifier::Alt => VK_LMENU,
        Modifier::Shift => VK_LSHIFT,
        Modifier::Cmd | Modifier::Win => VK_LWIN,
    }
}

// ---------------------------------------------------------------------------
// SendInput injection.

fn inject(events: &[SyntheticEvent]) {
    let mut inputs: SmallVec<[INPUT; 8]> = SmallVec::new();
    for ev in events {
        let (vk, flags) = match ev {
            SyntheticEvent::ModifierDown(m) => (modifier_to_vk(*m), 0u32),
            SyntheticEvent::ModifierUp(m) => (modifier_to_vk(*m), KEYEVENTF_KEYUP.0),
            SyntheticEvent::KeyDown(k) => (named_to_vk(*k), 0u32),
            SyntheticEvent::KeyUp(k) => (named_to_vk(*k), KEYEVENTF_KEYUP.0),
        };
        inputs.push(build_input(vk, flags));
    }
    if inputs.is_empty() {
        return;
    }
    unsafe {
        SendInput(&inputs, std::mem::size_of::<INPUT>() as i32);
    }
}

fn build_input(vk: VIRTUAL_KEY, flags: u32) -> INPUT {
    INPUT {
        r#type: INPUT_KEYBOARD,
        Anonymous: INPUT_0 {
            ki: KEYBDINPUT {
                wVk: vk,
                wScan: 0,
                dwFlags: windows::Win32::UI::Input::KeyboardAndMouse::KEYBD_EVENT_FLAGS(flags),
                time: 0,
                dwExtraInfo: INJECT_TAG,
            },
        },
    }
}
