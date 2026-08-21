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
use windows::Win32::Foundation::{HWND, LPARAM, LRESULT, WPARAM};
use windows::Win32::System::Threading::GetCurrentProcessId;
use windows::Win32::UI::Input::KeyboardAndMouse::{
    GetAsyncKeyState, GetKeyboardLayout, GetKeyboardLayoutList, SendInput, HKL, INPUT, INPUT_0,
    INPUT_KEYBOARD, KEYBDINPUT, KEYEVENTF_KEYUP, VIRTUAL_KEY, VK_CAPITAL, VK_CONTROL, VK_ESCAPE,
    VK_F4, VK_LCONTROL, VK_LMENU, VK_LSHIFT, VK_LWIN, VK_MENU, VK_RCONTROL, VK_RMENU, VK_RSHIFT,
    VK_RWIN, VK_SHIFT, VK_SPACE,
};
use windows::Win32::UI::WindowsAndMessaging::{
    CallNextHookEx, DispatchMessageW, GetForegroundWindow, GetMessageW, GetWindowThreadProcessId,
    PostMessageW, PostThreadMessageW, SetWindowsHookExW, TranslateMessage, UnhookWindowsHookEx,
    KBDLLHOOKSTRUCT, LLKHF_INJECTED, LLMHF_INJECTED, MSG, MSLLHOOKSTRUCT, WH_KEYBOARD_LL,
    WH_MOUSE_LL, WM_INPUTLANGCHANGEREQUEST, WM_KEYDOWN, WM_KEYUP, WM_LBUTTONDOWN, WM_MBUTTONDOWN,
    WM_QUIT, WM_RBUTTONDOWN, WM_SYSKEYDOWN, WM_SYSKEYUP, WM_XBUTTONDOWN,
};

use super::rules::{LanguageCode, Modifier, ModifierMask, NamedKey, ResolvedRules, SyntheticEvent};
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

            // Low-level mouse hook on the SAME thread — the GetMessageW pump
            // below serves it too. It only feeds button-downs to the state
            // machine so a click can cancel a pending transparent-modifier tap
            // (Shift+Click shouldn't also fire Shift's on_tap). Best-effort: if
            // it fails to install, keyboard remapping still works, so we log
            // and carry on rather than aborting the whole hook.
            let mouse_hook = match SetWindowsHookExW(WH_MOUSE_LL, Some(mouse_proc), None, 0) {
                Ok(h) => Some(h),
                Err(err) => {
                    eprintln!("[keyboard-remap] mouse hook install failed: {err}");
                    None
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
            if let Some(mh) = mouse_hook {
                let _ = UnhookWindowsHookEx(mh);
            }
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
        // carry the flag — no per-event override needed. `ForwardWithModifiers`
        // is a macOS-specific concept that Windows collapses into Forward.
        Action::ForwardWithModifiers(_) => CallNextHookEx(None, code, wparam, lparam),
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
        // SendInput already updates the global key state for any modifier
        // we injected, so subsequent real events (including the original
        // we're about to forward) naturally carry the flag — there's no
        // per-event override to apply on Windows.
        Action::EmitThenForwardWithModifiers(events, _) => {
            inject(events.as_slice());
            CallNextHookEx(None, code, wparam, lparam)
        }
    }
}

// ---------------------------------------------------------------------------
// LL mouse hook procedure.
//
// Installed on the same thread as the keyboard hook. Its only job is to let a
// mouse click cancel a pending transparent-modifier tap: when Shift (or
// CapsLock-as-Ctrl) is held as an `EagerModifier`, the modifier is already
// physically down, so the click carries it — but the state machine, being
// keyboard-only, would otherwise see a clean tap on release and fire the
// trigger's on_tap (opening the search window). Feeding the button-down in
// promotes the state to `Modifying`, cancelling that tap. We never suppress
// the click itself.

unsafe extern "system" fn mouse_proc(code: i32, wparam: WPARAM, lparam: LPARAM) -> LRESULT {
    if code < 0 {
        return CallNextHookEx(None, code, wparam, lparam);
    }

    let info = &*(lparam.0 as *const MSLLHOOKSTRUCT);

    // Ignore anything we (or another tool) injected — we don't inject mouse
    // events, but a synthetic click shouldn't cancel a tap either.
    if (info.flags & LLMHF_INJECTED) != 0 {
        return CallNextHookEx(None, code, wparam, lparam);
    }

    let is_button_down = matches!(
        wparam.0 as u32,
        WM_LBUTTONDOWN | WM_RBUTTONDOWN | WM_MBUTTONDOWN | WM_XBUTTONDOWN
    );
    if is_button_down {
        // Short critical section — flip the state machine's tap flag. The
        // returned Action is internal-only (no injection); we always let the
        // click through.
        let mut slot = HOOK_SLOT.lock();
        if let Some(active) = slot.as_mut() {
            let _ = active.sm.on_pointer_down();
        }
    }

    CallNextHookEx(None, code, wparam, lparam)
}

// ---------------------------------------------------------------------------
// Mapping from Windows VK codes to logical keys.

fn vk_to_logical(vk: u32) -> LogicalKey {
    use windows::Win32::UI::Input::KeyboardAndMouse::{
        VK_APPS, VK_BACK, VK_DOWN, VK_END, VK_ESCAPE as VK_ESC_C, VK_F1, VK_F10, VK_F11, VK_F12,
        VK_F2, VK_F3, VK_F4 as VK_F4_C, VK_F5, VK_F6, VK_F7, VK_F8, VK_F9, VK_HOME, VK_LEFT,
        VK_NEXT, VK_OEM_1, VK_OEM_2, VK_OEM_3, VK_OEM_4, VK_OEM_5, VK_OEM_6, VK_OEM_7,
        VK_OEM_COMMA, VK_OEM_MINUS, VK_OEM_PERIOD, VK_OEM_PLUS, VK_PRIOR, VK_RETURN, VK_RIGHT,
        VK_TAB, VK_UP,
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
    // Shift / Ctrl / Alt / Win — keep L/R variants when Windows gives them
    // to us. Unsided VKs are rare in the low-level hook but still map to the
    // generic key so existing configs remain meaningful.
    match VIRTUAL_KEY(vk as u16) {
        k if k == VK_SHIFT => return LogicalKey::Shift,
        k if k == VK_LSHIFT => return LogicalKey::LeftShift,
        k if k == VK_RSHIFT => return LogicalKey::RightShift,
        k if k == VK_CONTROL => return LogicalKey::Ctrl,
        k if k == VK_LCONTROL => return LogicalKey::LeftCtrl,
        k if k == VK_RCONTROL => return LogicalKey::RightCtrl,
        k if k == VK_MENU => return LogicalKey::Alt,
        k if k == VK_LMENU => return LogicalKey::LeftAlt,
        k if k == VK_RMENU => return LogicalKey::RightAlt,
        k if k == VK_LWIN => return LogicalKey::LeftCmd,
        k if k == VK_RWIN => return LogicalKey::RightCmd,
        _ => {}
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
        v if v == VK_APPS.0 => NamedKey::Apps,
        _ => return LogicalKey::Other,
    };
    LogicalKey::Named(nk)
}

fn named_to_vk(key: NamedKey) -> VIRTUAL_KEY {
    use windows::Win32::UI::Input::KeyboardAndMouse::{
        VK_APPS, VK_BACK, VK_DOWN, VK_END, VK_F1, VK_F10, VK_F11, VK_F12, VK_F2, VK_F3, VK_F5,
        VK_F6, VK_F7, VK_F8, VK_F9, VK_HOME, VK_LEFT, VK_NEXT, VK_OEM_1, VK_OEM_2, VK_OEM_3,
        VK_OEM_4, VK_OEM_5, VK_OEM_6, VK_OEM_7, VK_OEM_COMMA, VK_OEM_MINUS, VK_OEM_PERIOD,
        VK_OEM_PLUS, VK_PRIOR, VK_RETURN, VK_RIGHT, VK_TAB, VK_UP,
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
        NamedKey::Apps => VK_APPS,
        NamedKey::Alpha(b) => VIRTUAL_KEY(b as u16),
    }
}

fn modifier_to_vk(m: Modifier) -> VIRTUAL_KEY {
    match m {
        Modifier::Ctrl => VK_LCONTROL,
        Modifier::LeftCtrl => VK_LCONTROL,
        Modifier::RightCtrl => VK_RCONTROL,
        Modifier::Alt => VK_LMENU,
        Modifier::LeftAlt => VK_LMENU,
        Modifier::RightAlt => VK_RMENU,
        Modifier::Shift => VK_LSHIFT,
        Modifier::LeftShift => VK_LSHIFT,
        Modifier::RightShift => VK_RSHIFT,
        Modifier::Cmd | Modifier::Win => VK_LWIN,
        Modifier::LeftCmd | Modifier::LeftWin => VK_LWIN,
        Modifier::RightCmd | Modifier::RightWin => VK_RWIN,
    }
}

/// Snapshot current physical modifier state via `GetAsyncKeyState`. The
/// high bit being set means the key is currently down. Queries both L/R
/// variants for each modifier since either side can be pressed.
fn current_modifier_mask() -> ModifierMask {
    let mut m = ModifierMask::EMPTY;
    unsafe {
        let left_shift = is_down(VK_LSHIFT);
        let right_shift = is_down(VK_RSHIFT);
        if left_shift {
            m.insert(Modifier::LeftShift);
        }
        if right_shift {
            m.insert(Modifier::RightShift);
        }
        if !left_shift && !right_shift && is_down(VK_SHIFT) {
            m.insert(Modifier::Shift);
        }

        let left_ctrl = is_down(VK_LCONTROL);
        let right_ctrl = is_down(VK_RCONTROL);
        if left_ctrl {
            m.insert(Modifier::LeftCtrl);
        }
        if right_ctrl {
            m.insert(Modifier::RightCtrl);
        }
        if !left_ctrl && !right_ctrl && is_down(VK_CONTROL) {
            m.insert(Modifier::Ctrl);
        }

        let left_alt = is_down(VK_LMENU);
        let right_alt = is_down(VK_RMENU);
        if left_alt {
            m.insert(Modifier::LeftAlt);
        }
        if right_alt {
            m.insert(Modifier::RightAlt);
        }
        if !left_alt && !right_alt && is_down(VK_MENU) {
            m.insert(Modifier::Alt);
        }

        if is_down(VK_LWIN) {
            m.insert(Modifier::LeftCmd);
        }
        if is_down(VK_RWIN) {
            m.insert(Modifier::RightCmd);
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
            SyntheticEvent::ChangeLanguage(code) => {
                flush_inputs(&mut inputs);
                change_language(*code);
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

/// Post-switch focus hand-off, queued to a dedicated worker thread.
///
/// MUST NOT run inline in the LL hook callback: the COM-backed Z-order scan
/// plus the AttachThreadInput/SetForegroundWindow dance routinely exceeds
/// `LowLevelHooksTimeout` (~300 ms default), and Windows responds by
/// *silently removing the hook* — the first switch works, then every later
/// hotkey goes unheard. The hook only enqueues; this thread does the work.
enum FocusJob {
    /// Focus the topmost switchable window on the (new) current desktop.
    TopmostOnCurrentDesktop,
    /// Re-assert focus on a specific window (the move_to_workspace follow).
    /// Raw HWND value — HWND itself isn't Send.
    Window(isize),
}

static FOCUS_TX: once_cell::sync::Lazy<Option<std::sync::mpsc::Sender<FocusJob>>> =
    once_cell::sync::Lazy::new(|| {
        let (tx, rx) = std::sync::mpsc::channel::<FocusJob>();
        thread::Builder::new()
            .name("runwa-vd-focus".into())
            .spawn(move || {
                while let Ok(first) = rx.recv() {
                    // Give the desktop switch a beat to commit before we
                    // inspect cloak/desktop state.
                    thread::sleep(std::time::Duration::from_millis(50));
                    // Coalesce bursts (held-down switch chord): only the
                    // focus for the final destination desktop matters.
                    let mut job = first;
                    while let Ok(next) = rx.try_recv() {
                        job = next;
                    }
                    match job {
                        FocusJob::TopmostOnCurrentDesktop => {
                            crate::windows_impl::focus_topmost_after_desktop_switch();
                        }
                        FocusJob::Window(raw) => unsafe {
                            crate::windows_impl::force_foreground_hwnd(HWND(raw as *mut _));
                        },
                    }
                }
            })
            .ok()
            .map(|_join| tx)
    });

/// Enqueue a focus job for the worker thread. Drops the job silently if the
/// worker failed to spawn (OOM-class failure) — focus hand-off is best-effort.
fn queue_focus_job(job: FocusJob) {
    if let Some(tx) = FOCUS_TX.as_ref() {
        let _ = tx.send(job);
    }
}

// ---------------------------------------------------------------------------
// Virtual-desktop switching with an "alternate desktop" toggle.
//
// We remember the desktop we were on before the most recent switch — the
// "alternate", nvim's `#` buffer. Asking to switch to the desktop you're
// already on jumps to that alternate instead, so tapping the same hotkey
// flips back and forth between your last two desktops. The decision happens
// on the chord's KeyDown — no delay.
//
// The state machine routes workspace switches through its held path so they
// fire exactly once per press rather than re-firing on every OS autorepeat.
// That matters here: re-running the toggle on autorepeat would ping-pong
// between the two desktops while the key stays down.

#[derive(Default)]
struct VdState {
    /// The desktop we were on immediately before the most recent switch — the
    /// one a same-desktop tap toggles back to. `None` until runwa makes its
    /// first switch.
    alternate: Option<u32>,
}

static VD_STATE: once_cell::sync::Lazy<Mutex<VdState>> =
    once_cell::sync::Lazy::new(|| Mutex::new(VdState::default()));

/// 0-based index of the active virtual desktop, or `None` if winvd can't tell
/// us (older Windows builds, COM hiccups).
fn current_desktop_idx() -> Option<u32> {
    winvd::get_current_desktop().ok()?.get_index().ok()
}

/// Perform an actual desktop switch and record where we came from as the new
/// alternate. `from` is the desktop we're leaving (used only to update the
/// alternate); pass `None` to leave the alternate untouched.
fn perform_switch(target: u32, from: Option<u32>) {
    if let Err(e) = winvd::switch_desktop(target) {
        eprintln!("[keyboard-remap] switch_to_workspace {}: {e:?}", target + 1);
        return;
    }
    // Remember the desktop we left so the next same-desktop tap toggles back.
    if let Some(prev) = from {
        if prev != target {
            VD_STATE.lock().alternate = Some(prev);
        }
    }
    // Push the new ordinal to the tray — no polling needed.
    super::desktop::record(target);
    // winvd::switch_desktop doesn't restore focus the way Win+Ctrl+Arrow does,
    // so hand the foreground to whatever window now sits on top of the desktop
    // we just landed on — otherwise focus stays stranded on the desktop we left.
    queue_focus_job(FocusJob::TopmostOnCurrentDesktop);
}

/// `switch_to_workspace: n` (1-indexed). Switches to desktop `n`, or — when
/// you're already on `n` — toggles to the alternate (previous) desktop.
fn vd_switch(n: u32) {
    // winvd is 0-indexed; the user writes 1-indexed in YAML.
    let Some(target) = n.checked_sub(1) else {
        return;
    };
    let current = current_desktop_idx();
    if current == Some(target) {
        // Already here — jump to the alternate, nvim `#`-style. If we've never
        // switched yet there's nothing to toggle to, so stay put.
        let alternate = VD_STATE.lock().alternate;
        if let Some(alt) = alternate {
            perform_switch(alt, current);
        }
        return;
    }
    perform_switch(target, current);
}

fn vd_move_active_and_follow(n: u32) {
    let Some(idx) = n.checked_sub(1) else {
        return;
    };
    let from = current_desktop_idx();
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
        return;
    }
    // Followed the window across — keep the alternate coherent so a later
    // same-desktop tap toggles back to where we came from.
    if let Some(prev) = from {
        if prev != idx {
            VD_STATE.lock().alternate = Some(prev);
        }
    }
    // Followed the window to the target desktop — push it to the tray.
    super::desktop::record(idx);
    // Re-assert focus on the window that followed us across; like a plain
    // switch, the move+switch alone can leave the foreground stranded on the
    // desktop we left rather than on the window the user just carried over.
    queue_focus_job(FocusJob::Window(hwnd.0 as isize));
}

/// Switch the foreground window's input language by ISO 639-1 code (`en`,
/// `ru`, …). Fire-and-forget: the real work is queued onto a worker
/// thread, because it drives the shell's own input-switch hotkey and then
/// polls for the result — tens of milliseconds, far past what
/// `LowLevelHooksTimeout` tolerates inside the hook callback.
pub(super) fn change_language(code: LanguageCode) {
    queue_language_job(code);
}

/// Entry point for the JS-side `setInputLanguage` (the palette's "switch
/// to English on open"). The palette grabs focus before calling, so the
/// window we're switching for is one of ours — and against our own window
/// the legacy path is both safe and invisible, so keep using it there.
/// Anything else means the focus grab didn't land and we're aimed at a
/// foreign app, which takes the same queued path as a remap rule.
pub(super) fn set_input_language(code: LanguageCode) {
    let hwnd = unsafe { GetForegroundWindow() };
    if hwnd.0.is_null() || !owned_by_this_process(hwnd) {
        queue_language_job(code);
        return;
    }
    let Some(hkl) = resolve_layout(code) else {
        return;
    };
    unsafe {
        if let Err(e) = PostMessageW(
            hwnd,
            WM_INPUTLANGCHANGEREQUEST,
            WPARAM(0),
            LPARAM(hkl.0 as isize),
        ) {
            eprintln!("[keyboard-remap] set_input_language: PostMessage failed: {e:?}");
        }
    }
}

// ---------------------------------------------------------------------------
// Input-language switching.
//
// We drive the shell's own Win+Space switcher rather than activating the
// layout ourselves. The obvious API — posting `WM_INPUTLANGCHANGEREQUEST`
// to the foreground window, which `DefWindowProc` turns into
// `ActivateKeyboardLayout` — permanently wedges TSF-based apps: Warp hangs
// the instant it receives one, with or without `INPUTLANGCHANGE_SYSCHARSET`
// in `wParam`, while Win+Space switches it fine. Confirmed by posting the
// message from a plain PowerShell script, outside our hook, so it isn't a
// hook-context problem — the legacy path itself is what those apps can't
// survive.
//
// Win+Space only *cycles*, so "switch to Russian" becomes press-and-verify:
// read the target thread's layout after each press and stop the moment it
// matches. That bounds us at one press per loaded layout, lands exactly on
// the requested language however many are installed, and makes a repeat of
// the same chord a no-op — no switcher overlay, no cycling past the
// language you asked for.

/// How long to give one Win+Space press to land before pressing again.
const LANG_SETTLE: std::time::Duration = std::time::Duration::from_millis(400);

/// Polling interval while waiting for a press to take effect.
const LANG_POLL: std::time::Duration = std::time::Duration::from_millis(15);

static LANG_TX: once_cell::sync::Lazy<Option<std::sync::mpsc::Sender<LanguageCode>>> =
    once_cell::sync::Lazy::new(|| {
        let (tx, rx) = std::sync::mpsc::channel::<LanguageCode>();
        thread::Builder::new()
            .name("runwa-lang-switch".into())
            .spawn(move || {
                while let Ok(first) = rx.recv() {
                    // Coalesce a burst — only the last language asked for
                    // matters, and cycling toward a superseded one just
                    // flashes the overlay for nothing.
                    let mut code = first;
                    while let Ok(next) = rx.try_recv() {
                        code = next;
                    }
                    apply_language(code);
                }
            })
            .ok()
            .map(|_join| tx)
    });

/// Enqueue a language switch. Drops it silently if the worker failed to
/// spawn (OOM-class failure) — switching is best-effort.
fn queue_language_job(code: LanguageCode) {
    if let Some(tx) = LANG_TX.as_ref() {
        let _ = tx.send(code);
    }
}

fn apply_language(code: LanguageCode) {
    let Some(target) = resolve_layout(code) else {
        return;
    };
    let target_lang = hkl_primary(target);

    // Capture the window the user was in up front: the switcher overlay
    // comes and goes while we cycle, and the layout we care about is the
    // one on the thread that asked for the change.
    let hwnd = unsafe { GetForegroundWindow() };
    if hwnd.0.is_null() {
        return;
    }
    let tid = unsafe { GetWindowThreadProcessId(hwnd, None) };
    if tid == 0 {
        return;
    }

    // One full cycle visits every loaded entry, so that many presses is
    // always enough to reach any one of them.
    let presses = loaded_layouts().len().max(1);
    for _ in 0..presses {
        if thread_primary_lang(tid) == Some(target_lang) {
            return;
        }
        press_switch_hotkey();
        if wait_for_lang(tid, target_lang) {
            return;
        }
    }

    eprintln!(
        "[keyboard-remap] change_language: cycled {presses}x without reaching '{}' \
         — is the Win+Space input-switch hotkey disabled?",
        code.as_str()
    );
}

/// Inject the shell's input-switch chord. The remap layer's physical
/// trigger (Space) is held at this point but was suppressed by the hook,
/// so the OS never saw it go down and the injected Space is a clean,
/// self-contained press. Both events carry `INJECT_TAG`, so our own hook
/// skips them on the way back in.
fn press_switch_hotkey() {
    let inputs = [
        build_input(VK_LWIN, 0),
        build_input(VK_SPACE, 0),
        build_input(VK_SPACE, KEYEVENTF_KEYUP.0),
        build_input(VK_LWIN, KEYEVENTF_KEYUP.0),
    ];
    unsafe {
        SendInput(&inputs, std::mem::size_of::<INPUT>() as i32);
    }
}

fn wait_for_lang(tid: u32, target_lang: u16) -> bool {
    let deadline = std::time::Instant::now() + LANG_SETTLE;
    loop {
        if thread_primary_lang(tid) == Some(target_lang) {
            return true;
        }
        if std::time::Instant::now() >= deadline {
            return false;
        }
        thread::sleep(LANG_POLL);
    }
}

/// Active input locale of another thread — works cross-process for any
/// thread on our desktop, which is how we verify a press landed.
fn thread_primary_lang(tid: u32) -> Option<u16> {
    let hkl = unsafe { GetKeyboardLayout(tid) };
    if hkl.0.is_null() {
        return None;
    }
    Some(hkl_primary(hkl))
}

/// The loaded keyboard layouts, in the order the shell cycles them.
fn loaded_layouts() -> Vec<HKL> {
    // First call with None returns the count; second fills the buffer.
    let count = unsafe { GetKeyboardLayoutList(None) };
    if count <= 0 {
        return Vec::new();
    }
    let mut layouts: Vec<HKL> = vec![HKL(std::ptr::null_mut()); count as usize];
    let written = unsafe { GetKeyboardLayoutList(Some(layouts.as_mut_slice())) };
    if written <= 0 {
        return Vec::new();
    }
    layouts.truncate(written as usize);
    layouts
}

/// The HKL low word is the Locale ID; its low 10 bits are the primary
/// language ID (e.g. 0x09 = English, 0x19 = Russian). Matching on that
/// rather than the full LCID keeps `ru` matching whatever Russian variant
/// the user actually has installed.
fn hkl_primary(hkl: HKL) -> u16 {
    ((hkl.0 as usize) as u16) & 0x03FF
}

/// Resolve an ISO 639-1 code to a loaded layout, logging the two ways this
/// legitimately fails: a code we don't map, or a language the user hasn't
/// added in Windows language settings.
fn resolve_layout(code: LanguageCode) -> Option<HKL> {
    let Some(primary_lang) = primary_lang_id(code.as_str()) else {
        eprintln!(
            "[keyboard-remap] change_language: unsupported code '{}'",
            code.as_str()
        );
        return None;
    };

    let found = loaded_layouts()
        .into_iter()
        .find(|hkl| hkl_primary(*hkl) == primary_lang);

    if found.is_none() {
        eprintln!(
            "[keyboard-remap] change_language: no loaded layout for '{}' \
             (primary lang 0x{primary_lang:X}); add it in Windows language settings",
            code.as_str()
        );
    }
    found
}

fn owned_by_this_process(hwnd: HWND) -> bool {
    let mut pid = 0u32;
    unsafe {
        GetWindowThreadProcessId(hwnd, Some(&mut pid));
        pid != 0 && pid == GetCurrentProcessId()
    }
}

/// Map an ISO 639-1 code to the Windows primary language ID (low 10 bits
/// of the LCID). Covers the languages most likely to show up alongside
/// `en` and `ru`; extend as needed.
fn primary_lang_id(code: &str) -> Option<u16> {
    match code {
        "en" => Some(0x09),
        "ru" => Some(0x19),
        "uk" => Some(0x22),
        "de" => Some(0x07),
        "fr" => Some(0x0C),
        "es" => Some(0x0A),
        "it" => Some(0x10),
        "pt" => Some(0x16),
        "pl" => Some(0x15),
        "nl" => Some(0x13),
        "sv" => Some(0x1D),
        "tr" => Some(0x1F),
        "ja" => Some(0x11),
        "ko" => Some(0x12),
        "zh" => Some(0x04),
        "ar" => Some(0x01),
        "he" => Some(0x0D),
        _ => None,
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
