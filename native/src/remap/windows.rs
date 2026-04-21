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
    GetAsyncKeyState, SendInput, INPUT, INPUT_0, INPUT_KEYBOARD, KEYBDINPUT, KEYEVENTF_KEYUP,
    VIRTUAL_KEY, VK_CAPITAL, VK_CONTROL, VK_ESCAPE, VK_F4, VK_LCONTROL, VK_LMENU, VK_LSHIFT,
    VK_LWIN, VK_MENU, VK_RCONTROL, VK_RMENU, VK_RSHIFT, VK_RWIN, VK_SHIFT, VK_SPACE,
};
use windows::Win32::UI::WindowsAndMessaging::{
    CallNextHookEx, DispatchMessageW, GetMessageW, PostThreadMessageW, SetWindowsHookExW,
    TranslateMessage, UnhookWindowsHookEx, KBDLLHOOKSTRUCT, LLKHF_INJECTED, MSG,
    WH_KEYBOARD_LL, WM_KEYDOWN, WM_KEYUP, WM_QUIT, WM_SYSKEYDOWN, WM_SYSKEYUP,
};

use super::rules::{Modifier, ModifierMask, NamedKey, ResolvedRules, SyntheticEvent};
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
    sm: StateMachine,
}

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
    let ev = RawEvent {
        kind,
        key,
        // Physical modifier snapshot via `GetAsyncKeyState`, which reports
        // real-time key state regardless of thread/message-queue state.
        // Needed so `keys: [shift, 1]` rules can match against the user's
        // held Shift at the moment 1 was pressed.
        modifiers: current_modifier_mask(),
    };

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
        // Windows' SendInput already updated the global key state when we
        // synthesized the modifier-down, so subsequent real events naturally
        // carry the flag — no per-event override needed. `ForwardWithModifier`
        // is a macOS-specific concept that Windows collapses into Forward.
        Action::ForwardWithModifier(_) => CallNextHookEx(None, code, wparam, lparam),
        Action::Suppress => LRESULT(1),
        // On Windows the tap-vs-interruption distinction doesn't matter —
        // SendInput doesn't stamp per-event modifier flags, each KEYBDINPUT
        // carries its own state. Both `EmitTap` and `Emit` share the same
        // injector path.
        Action::EmitTap(events) | Action::Emit(events) => {
            // Inject all events synchronously. SendInput runs fast and
            // enqueues the events — the injected events will re-enter this
            // hook with the INJECT_TAG and be skipped.
            inject(events.as_slice());
            LRESULT(1)
        }
        Action::EmitThenForward(events) => {
            // Inject the synthetics (e.g. a prefix modifier-down), then let
            // the original event continue so the OS sees it naturally.
            inject(events.as_slice());
            CallNextHookEx(None, code, wparam, lparam)
        }
    }
}

// ---------------------------------------------------------------------------
// Mapping from Windows VK codes to logical keys.

fn vk_to_logical(vk: u32) -> LogicalKey {
    use windows::Win32::UI::Input::KeyboardAndMouse::{
        VK_BACK, VK_DOWN, VK_END, VK_ESCAPE as VK_ESC_C, VK_F1, VK_F10, VK_F11, VK_F12, VK_F2,
        VK_F3, VK_F4 as VK_F4_C, VK_F5, VK_F6, VK_F7, VK_F8, VK_F9, VK_HOME, VK_LEFT, VK_NEXT,
        VK_OEM_1, VK_OEM_2, VK_OEM_3, VK_OEM_4, VK_OEM_5, VK_OEM_6, VK_OEM_7, VK_OEM_COMMA,
        VK_OEM_MINUS, VK_OEM_PERIOD, VK_OEM_PLUS, VK_PRIOR, VK_RETURN, VK_RIGHT, VK_TAB, VK_UP,
    };
    const VK_A: u32 = 0x41;
    const VK_Z: u32 = 0x5A;
    const VK_0: u32 = 0x30;
    const VK_9: u32 = 0x39;
    if vk == VK_CAPITAL.0 as u32 {
        return LogicalKey::CapsLock;
    }
    if vk == VK_SPACE.0 as u32 {
        return LogicalKey::Space;
    }
    // Shift / Ctrl / Alt / Win — including L/R variants and the unsided
    // VKs some apps send. Each maps to a specific `LogicalKey` variant
    // so users can configure any of them as a top-level trigger; when
    // unconfigured, the state machine forwards them transparently so the
    // physical modifier still applies to the next key.
    const SHIFT_VKS: &[VIRTUAL_KEY] = &[VK_SHIFT, VK_LSHIFT, VK_RSHIFT];
    const CTRL_VKS: &[VIRTUAL_KEY] = &[VK_CONTROL, VK_LCONTROL, VK_RCONTROL];
    const ALT_VKS: &[VIRTUAL_KEY] = &[VK_MENU, VK_LMENU, VK_RMENU];
    const WIN_VKS: &[VIRTUAL_KEY] = &[VK_LWIN, VK_RWIN];
    if SHIFT_VKS.iter().any(|m| m.0 as u32 == vk) {
        return LogicalKey::Shift;
    }
    if CTRL_VKS.iter().any(|m| m.0 as u32 == vk) {
        return LogicalKey::Ctrl;
    }
    if ALT_VKS.iter().any(|m| m.0 as u32 == vk) {
        return LogicalKey::Alt;
    }
    if WIN_VKS.iter().any(|m| m.0 as u32 == vk) {
        // Treated as `Cmd` in the state machine — cross-platform alias.
        return LogicalKey::Cmd;
    }
    if (VK_A..=VK_Z).contains(&vk) {
        return LogicalKey::Named(NamedKey::Alpha((b'A' + (vk - VK_A) as u8) as u8));
    }
    if (VK_0..=VK_9).contains(&vk) {
        return LogicalKey::Named(NamedKey::Alpha((b'0' + (vk - VK_0) as u8) as u8));
    }
    let nk = match vk as u16 {
        v if v == VK_ESC_C.0 => NamedKey::Escape,
        v if v == VK_TAB.0 => NamedKey::Tab,
        v if v == VK_RETURN.0 => NamedKey::Return,
        v if v == VK_BACK.0 => NamedKey::Delete,
        v if v == VK_F1.0 => NamedKey::F1,
        v if v == VK_F2.0 => NamedKey::F2,
        v if v == VK_F3.0 => NamedKey::F3,
        v if v == VK_F4_C.0 => NamedKey::F4,
        v if v == VK_F5.0 => NamedKey::F5,
        v if v == VK_F6.0 => NamedKey::F6,
        v if v == VK_F7.0 => NamedKey::F7,
        v if v == VK_F8.0 => NamedKey::F8,
        v if v == VK_F9.0 => NamedKey::F9,
        v if v == VK_F10.0 => NamedKey::F10,
        v if v == VK_F11.0 => NamedKey::F11,
        v if v == VK_F12.0 => NamedKey::F12,
        v if v == VK_LEFT.0 => NamedKey::Left,
        v if v == VK_RIGHT.0 => NamedKey::Right,
        v if v == VK_UP.0 => NamedKey::Up,
        v if v == VK_DOWN.0 => NamedKey::Down,
        v if v == VK_HOME.0 => NamedKey::Home,
        v if v == VK_END.0 => NamedKey::End,
        v if v == VK_PRIOR.0 => NamedKey::PageUp,
        v if v == VK_NEXT.0 => NamedKey::PageDown,
        v if v == VK_OEM_3.0 => NamedKey::Backtick,
        v if v == VK_OEM_MINUS.0 => NamedKey::Minus,
        v if v == VK_OEM_PLUS.0 => NamedKey::Equals,
        v if v == VK_OEM_4.0 => NamedKey::LeftBracket,
        v if v == VK_OEM_6.0 => NamedKey::RightBracket,
        v if v == VK_OEM_5.0 => NamedKey::Backslash,
        v if v == VK_OEM_1.0 => NamedKey::Semicolon,
        v if v == VK_OEM_7.0 => NamedKey::Quote,
        v if v == VK_OEM_COMMA.0 => NamedKey::Comma,
        v if v == VK_OEM_PERIOD.0 => NamedKey::Period,
        v if v == VK_OEM_2.0 => NamedKey::Slash,
        _ => return LogicalKey::Other,
    };
    LogicalKey::Named(nk)
}

fn named_to_vk(key: NamedKey) -> VIRTUAL_KEY {
    use windows::Win32::UI::Input::KeyboardAndMouse::{
        VK_BACK, VK_DOWN, VK_END, VK_F1, VK_F10, VK_F11, VK_F12, VK_F2, VK_F3, VK_F5, VK_F6,
        VK_F7, VK_F8, VK_F9, VK_HOME, VK_LEFT, VK_NEXT, VK_OEM_1, VK_OEM_2, VK_OEM_3, VK_OEM_4,
        VK_OEM_5, VK_OEM_6, VK_OEM_7, VK_OEM_COMMA, VK_OEM_MINUS, VK_OEM_PERIOD, VK_OEM_PLUS,
        VK_PRIOR, VK_RETURN, VK_RIGHT, VK_TAB, VK_UP,
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
        NamedKey::Left => VK_LEFT,
        NamedKey::Right => VK_RIGHT,
        NamedKey::Up => VK_UP,
        NamedKey::Down => VK_DOWN,
        NamedKey::Home => VK_HOME,
        NamedKey::End => VK_END,
        NamedKey::PageUp => VK_PRIOR,
        NamedKey::PageDown => VK_NEXT,
        NamedKey::Backtick => VK_OEM_3,
        NamedKey::Minus => VK_OEM_MINUS,
        NamedKey::Equals => VK_OEM_PLUS,
        NamedKey::LeftBracket => VK_OEM_4,
        NamedKey::RightBracket => VK_OEM_6,
        NamedKey::Backslash => VK_OEM_5,
        NamedKey::Semicolon => VK_OEM_1,
        NamedKey::Quote => VK_OEM_7,
        NamedKey::Comma => VK_OEM_COMMA,
        NamedKey::Period => VK_OEM_PERIOD,
        NamedKey::Slash => VK_OEM_2,
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

/// Snapshot current physical modifier state via `GetAsyncKeyState`. The
/// high bit being set means the key is currently down. Queries both L/R
/// variants for each modifier since either side can be pressed.
fn current_modifier_mask() -> ModifierMask {
    let mut m = ModifierMask::EMPTY;
    unsafe {
        if is_down(VK_SHIFT) || is_down(VK_LSHIFT) || is_down(VK_RSHIFT) {
            m.insert(Modifier::Shift);
        }
        if is_down(VK_CONTROL) || is_down(VK_LCONTROL) || is_down(VK_RCONTROL) {
            m.insert(Modifier::Ctrl);
        }
        if is_down(VK_MENU) || is_down(VK_LMENU) || is_down(VK_RMENU) {
            m.insert(Modifier::Alt);
        }
        if is_down(VK_LWIN) || is_down(VK_RWIN) {
            m.insert(Modifier::Cmd);
        }
    }
    m
}

unsafe fn is_down(vk: VIRTUAL_KEY) -> bool {
    (GetAsyncKeyState(vk.0 as i32) as u16 & 0x8000) != 0
}

// ---------------------------------------------------------------------------
// SendInput injection.

fn inject(events: &[SyntheticEvent]) {
    // Keyboard inputs get batched into a single SendInput call (atomic —
    // no other input can interleave). VD switches happen out-of-band and
    // flush the pending keyboard batch before running.
    let mut inputs: SmallVec<[INPUT; 8]> = SmallVec::new();
    for ev in events {
        match ev {
            SyntheticEvent::ModifierDown(m) => {
                inputs.push(build_input(modifier_to_vk(*m), 0));
            }
            SyntheticEvent::ModifierUp(m) => {
                inputs.push(build_input(modifier_to_vk(*m), KEYEVENTF_KEYUP.0));
            }
            SyntheticEvent::KeyDown(k) => {
                inputs.push(build_input(named_to_vk(*k), 0));
            }
            SyntheticEvent::KeyUp(k) => {
                inputs.push(build_input(named_to_vk(*k), KEYEVENTF_KEYUP.0));
            }
            SyntheticEvent::SwitchToWorkspace(n) => {
                flush_inputs(&mut inputs);
                vd_switch(*n);
            }
            SyntheticEvent::MoveToWorkspace(n) => {
                flush_inputs(&mut inputs);
                vd_move_active_and_follow(*n);
            }
        }
    }
    flush_inputs(&mut inputs);
}

fn flush_inputs(inputs: &mut SmallVec<[INPUT; 8]>) {
    if inputs.is_empty() {
        return;
    }
    unsafe {
        SendInput(inputs.as_slice(), std::mem::size_of::<INPUT>() as i32);
    }
    inputs.clear();
}

fn vd_switch(n: u32) {
    // winvd is 0-indexed; the user writes 1-indexed in YAML.
    let Some(idx) = n.checked_sub(1) else {
        return;
    };
    if let Err(e) = winvd::switch_desktop(idx) {
        eprintln!("[keyboard-remap] switch_to_workspace {n}: {e:?}");
    }
}

fn vd_move_active_and_follow(n: u32) {
    let Some(idx) = n.checked_sub(1) else {
        return;
    };
    use windows::Win32::UI::WindowsAndMessaging::GetForegroundWindow;
    let hwnd = unsafe { GetForegroundWindow() };
    if hwnd.0.is_null() {
        return;
    }
    if let Err(e) = winvd::move_window_to_desktop(idx, &hwnd) {
        eprintln!("[keyboard-remap] move_to_workspace {n} (move): {e:?}");
        return;
    }
    if let Err(e) = winvd::switch_desktop(idx) {
        eprintln!("[keyboard-remap] move_to_workspace {n} (switch): {e:?}");
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
