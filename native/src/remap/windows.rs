//! Windows low-level keyboard hook.
//!
//! Architecture:
//!   - A dedicated thread installs `WH_KEYBOARD_LL`, then runs a
//!     `GetMessageW` pump. The hook proc bounces to a thread-local state
//!     machine guarded by a mutex.
//!   - A message-only window created on that thread re-installs the hook
//!     when the events that reshuffle the chain fire, so launch order
//!     doesn't decide who owns a key. See `ChainWatcher`.
//!   - Teardown posts `WM_QUIT` to the hook thread, which drops out of the
//!     message loop, calls `UnhookWindowsHookEx`, and exits.
//!   - All synthetic events go through `SendInput` carrying one of the
//!     `INJECT_TAG*` stamps in `dwExtraInfo`. A tagged event never reaches
//!     the state machine — we don't re-enter ourselves — and the tag picks
//!     which hooks *behind* ours get to see it.
//!
//! The LL hook runs on the thread that installed it; `LowLevelHooksTimeout`
//! (default 300ms) will force Windows to skip the hook if the callback
//! blocks, so the state machine path must stay allocation-light and lock
//! durations must be short.

use std::cell::Cell;
use std::sync::atomic::{AtomicBool, AtomicIsize, AtomicU32, Ordering};
use std::sync::Arc;
use std::thread;

use parking_lot::Mutex;
use smallvec::SmallVec;
use windows::core::{w, PCWSTR};
use windows::Win32::Foundation::{HANDLE, HINSTANCE, HWND, LPARAM, LRESULT, RECT, WPARAM};
use windows::Win32::Graphics::Gdi::{
    GetMonitorInfoW, MonitorFromWindow, MONITORINFO, MONITOR_DEFAULTTONEAREST,
};
use windows::Win32::System::LibraryLoader::GetModuleHandleW;
use windows::Win32::System::Power::{
    RegisterSuspendResumeNotification, UnregisterSuspendResumeNotification, HPOWERNOTIFY,
};
use windows::Win32::System::RemoteDesktop::{
    WTSRegisterSessionNotification, WTSUnRegisterSessionNotification, NOTIFY_FOR_THIS_SESSION,
};
use windows::Win32::System::Threading::GetCurrentProcessId;
use windows::Win32::UI::Input::KeyboardAndMouse::{
    GetAsyncKeyState, GetKeyboardLayout, GetKeyboardLayoutList, SendInput, HKL, INPUT, INPUT_0,
    INPUT_KEYBOARD, KEYBDINPUT, KEYEVENTF_KEYUP, VIRTUAL_KEY, VK_CAPITAL, VK_CONTROL, VK_ESCAPE,
    VK_F4, VK_LCONTROL, VK_LMENU, VK_LSHIFT, VK_LWIN, VK_MENU, VK_RCONTROL, VK_RMENU, VK_RSHIFT,
    VK_RWIN, VK_SHIFT, VK_SPACE,
};
use windows::Win32::UI::WindowsAndMessaging::{
    CallNextHookEx, CreateWindowExW, DefWindowProcW, DestroyWindow, DispatchMessageW,
    GetForegroundWindow, GetMessageW, GetWindowRect, GetWindowThreadProcessId, KillTimer,
    PostMessageW, PostThreadMessageW, RegisterClassW, SetTimer, SetWindowsHookExW,
    TranslateMessage, UnhookWindowsHookEx, DEVICE_NOTIFY_WINDOW_HANDLE, HHOOK, HWND_MESSAGE,
    KBDLLHOOKSTRUCT, LLKHF_INJECTED, LLMHF_INJECTED, MSG, MSLLHOOKSTRUCT, PBT_APMRESUMEAUTOMATIC,
    PBT_APMRESUMESUSPEND, WH_KEYBOARD_LL, WH_MOUSE_LL, WINDOW_EX_STYLE, WINDOW_STYLE, WM_CLOSE,
    WM_INPUTLANGCHANGEREQUEST, WM_KEYDOWN, WM_KEYUP, WM_LBUTTONDOWN, WM_MBUTTONDOWN,
    WM_POWERBROADCAST, WM_QUIT, WM_RBUTTONDOWN, WM_SYSKEYDOWN, WM_SYSKEYUP, WM_TIMER,
    WM_WTSSESSION_CHANGE, WM_XBUTTONDOWN, WNDCLASSW, WTS_CONSOLE_CONNECT, WTS_SESSION_UNLOCK,
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
            ACTIVE_KEYBOARD_HOOK.store(hhook.0 as isize, Ordering::SeqCst);

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

            // Subscriptions that keep us at the head of the hook chain. The
            // window is created on this thread, so its `WndProc` runs from
            // the pump below.
            let watcher = ChainWatcher::install();

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
            if let Some(watcher) = watcher {
                watcher.remove();
            }
            let hhook = HHOOK(ACTIVE_KEYBOARD_HOOK.swap(0, Ordering::SeqCst) as *mut _);
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
// Hook-chain ownership.
//
// Windows calls `WH_KEYBOARD_LL` hooks newest-first, so the app that
// installed last decides what the ones before it are even allowed to see.
// That makes launch order load-bearing, which it must not be. It bites in
// practice: a speech-to-text listener bound to CapsLock (Handy's
// `handy-keys` backend is one) *blocks* the key rather than observing it, so
// whenever it sits in front of us CapsLock stops producing Escape at all.
//
// Re-installing is the only lever. Windows offers no way to ask where we sit
// in the chain, and no way to notice we've been shadowed — raw input is no
// escape hatch either: a blocking hook runs *before* raw input is generated,
// so a suppressed key never shows up in `WM_INPUT` (measured, not assumed).
// The only real question is therefore what triggers a re-install. Two
// triggers, and no idle polling between them:
//
//   - The session and power notifications the watcher window subscribes to.
//     Unlock, console connect and resume from sleep are exactly the events
//     such listeners re-hook on themselves, which is precisely when they
//     would otherwise overtake us.
//   - A bounded burst after startup, because the launch race has no event to
//     hang off: nothing tells us another process just hooked, and a listener
//     that hooks only once its speech model has loaded can land a minute
//     after we do. The burst runs out and its timer is killed.

/// The live keyboard hook, as a raw `HHOOK` value. Global because the
/// watcher window's `WndProc` re-asserts it too, and that runs on the hook
/// thread but outside the frame that owns the handle. Zero means "no hook".
static ACTIVE_KEYBOARD_HOOK: AtomicIsize = AtomicIsize::new(0);

/// Delays between startup re-asserts, each measured from the previous one —
/// so roughly 2s, 7s, 17s, 47s, 1m47s and 3m47s after install. Long enough
/// to outlast a slow-starting competitor, finite so that steady state costs
/// nothing.
const STARTUP_REASSERT_SCHEDULE_MS: [u32; 6] = [2_000, 5_000, 10_000, 30_000, 60_000, 120_000];

/// How far through `STARTUP_REASSERT_SCHEDULE_MS` we are.
static STARTUP_BURST_STEP: AtomicU32 = AtomicU32::new(0);

/// Timer id for the startup burst, scoped to the watcher window.
const STARTUP_BURST_TIMER: usize = 1;

/// Whether the last re-assert failed, so a persistent failure logs once
/// rather than on every trigger.
static REASSERT_FAILING: AtomicBool = AtomicBool::new(false);

/// `WTS_REMOTE_CONNECT` — the crate binds its console sibling but not this
/// one. Reconnecting an RDP session lands here rather than in
/// `WTS_CONSOLE_CONNECT`.
const WTS_REMOTE_CONNECT: u32 = 3;

/// Put our keyboard hook back at the head of the low-level chain.
///
/// The replacement goes in *before* the old one comes out, so there's no
/// instant where keystrokes go unmapped. Both hooks run this thread's
/// `ll_proc` for that instant; `IN_LL_PROC` stops the nested call from
/// putting the same event through the state machine twice.
///
/// Doubles as recovery from Windows silently dropping the hook after a
/// `LowLevelHooksTimeout` overrun.
unsafe fn reassert_keyboard_hook(reason: &str) {
    let current = ACTIVE_KEYBOARD_HOOK.load(Ordering::SeqCst);
    if current == 0 {
        return;
    }
    match SetWindowsHookExW(WH_KEYBOARD_LL, Some(ll_proc), None, 0) {
        Ok(fresh) => {
            ACTIVE_KEYBOARD_HOOK.store(fresh.0 as isize, Ordering::SeqCst);
            let _ = UnhookWindowsHookEx(HHOOK(current as *mut _));
            REASSERT_FAILING.store(false, Ordering::Relaxed);
        }
        // Keep the hook we have — it still works, it's just no longer
        // guaranteed to be first. The next trigger tries again.
        Err(err) => {
            if !REASSERT_FAILING.swap(true, Ordering::Relaxed) {
                eprintln!("[keyboard-remap] hook re-assert ({reason}) failed: {err}");
            }
        }
    }
}

/// Message-only window holding the subscriptions that drive re-asserts.
struct ChainWatcher {
    hwnd: HWND,
    /// `HPOWERNOTIFY` from `RegisterSuspendResumeNotification`, or 0 when
    /// the subscription didn't take.
    power: isize,
}

impl ChainWatcher {
    /// Best-effort: every piece degrades on its own. Without the window
    /// there are no notifications and no burst, and the hook simply keeps
    /// whatever position it was installed at — which is what it did before
    /// any of this existed.
    unsafe fn install() -> Option<ChainWatcher> {
        let class = w!("runwa-keyboard-chain-watcher");
        let instance = HINSTANCE(GetModuleHandleW(None).ok()?.0);
        // Ignore the result: a second install in the same process finds the
        // class already registered, which is not an error for us.
        let _ = RegisterClassW(&WNDCLASSW {
            lpfnWndProc: Some(watcher_wndproc),
            lpszClassName: class,
            hInstance: instance,
            ..Default::default()
        });

        let hwnd = match CreateWindowExW(
            WINDOW_EX_STYLE(0),
            class,
            PCWSTR::null(),
            WINDOW_STYLE(0),
            0,
            0,
            0,
            0,
            HWND_MESSAGE,
            None,
            instance,
            None,
        ) {
            Ok(h) => h,
            Err(err) => {
                eprintln!(
                    "[keyboard-remap] chain watcher window failed ({err}); the hook \
                     won't reclaim the head of the chain after unlock or resume"
                );
                return None;
            }
        };

        if let Err(err) = WTSRegisterSessionNotification(hwnd, NOTIFY_FOR_THIS_SESSION) {
            eprintln!("[keyboard-remap] session notifications unavailable: {err}");
        }

        // `RegisterSuspendResumeNotification` (user32), not the powrprof
        // `PowerRegisterSuspendResumeNotification` — the latter rejects a
        // window recipient with ERROR_INVALID_PARAMETER and only takes a
        // callback.
        let power =
            match RegisterSuspendResumeNotification(HANDLE(hwnd.0), DEVICE_NOTIFY_WINDOW_HANDLE) {
                Ok(handle) => handle.0,
                Err(err) => {
                    eprintln!("[keyboard-remap] resume notifications unavailable: {err}");
                    0
                }
            };

        STARTUP_BURST_STEP.store(0, Ordering::SeqCst);
        arm_startup_burst(hwnd);

        Some(ChainWatcher { hwnd, power })
    }

    unsafe fn remove(self) {
        let _ = KillTimer(self.hwnd, STARTUP_BURST_TIMER);
        if self.power != 0 {
            let _ = UnregisterSuspendResumeNotification(HPOWERNOTIFY(self.power));
        }
        let _ = WTSUnRegisterSessionNotification(self.hwnd);
        let _ = DestroyWindow(self.hwnd);
    }
}

/// Schedule the next startup re-assert, or stop once the schedule is spent.
unsafe fn arm_startup_burst(hwnd: HWND) {
    let step = STARTUP_BURST_STEP.load(Ordering::SeqCst) as usize;
    match STARTUP_REASSERT_SCHEDULE_MS.get(step) {
        Some(&delay) => {
            SetTimer(hwnd, STARTUP_BURST_TIMER, delay, None);
        }
        None => {
            let _ = KillTimer(hwnd, STARTUP_BURST_TIMER);
        }
    }
}

unsafe extern "system" fn watcher_wndproc(
    hwnd: HWND,
    msg: u32,
    wparam: WPARAM,
    lparam: LPARAM,
) -> LRESULT {
    match msg {
        WM_TIMER if wparam.0 == STARTUP_BURST_TIMER => {
            reassert_keyboard_hook("startup");
            STARTUP_BURST_STEP.fetch_add(1, Ordering::SeqCst);
            arm_startup_burst(hwnd);
            LRESULT(0)
        }
        // Unlock and (re)connect are when a competing listener re-hooks.
        WM_WTSSESSION_CHANGE => {
            let event = wparam.0 as u32;
            if event == WTS_SESSION_UNLOCK
                || event == WTS_CONSOLE_CONNECT
                || event == WTS_REMOTE_CONNECT
            {
                reassert_keyboard_hook("session change");
            }
            LRESULT(0)
        }
        WM_POWERBROADCAST => {
            let event = wparam.0 as u32;
            if event == PBT_APMRESUMESUSPEND || event == PBT_APMRESUMEAUTOMATIC {
                reassert_keyboard_hook("resume");
            }
            LRESULT(1)
        }
        _ => DefWindowProcW(hwnd, msg, wparam, lparam),
    }
}

// ---------------------------------------------------------------------------
// LL hook procedure.

thread_local! {
    /// Set while `ll_proc` is deciding an event. During a re-assert both the
    /// fresh hook and the outgoing one are momentarily installed on this
    /// thread, and `CallNextHookEx` walks straight from one into the other.
    /// The nested call is an event we already handled, so it only forwards.
    static IN_LL_PROC: Cell<bool> = const { Cell::new(false) };
}

/// Clears `IN_LL_PROC` on the way out of `ll_proc`, which has far too many
/// early returns to unset it by hand.
struct LlProcGuard;

impl Drop for LlProcGuard {
    fn drop(&mut self) {
        IN_LL_PROC.with(|flag| flag.set(false));
    }
}

unsafe extern "system" fn ll_proc(code: i32, wparam: WPARAM, lparam: LPARAM) -> LRESULT {
    if code < 0 {
        return CallNextHookEx(None, code, wparam, lparam);
    }

    let info = &*(lparam.0 as *const KBDLLHOOKSTRUCT);

    // Events we injected ourselves never reach the state machine. The tag
    // decides what the hooks behind ours are allowed to do with them.
    //
    // This runs before the `IN_LL_PROC` check on purpose: `SendInput` called
    // from inside this proc re-enters it synchronously on this thread, before
    // `SendInput` returns (measured). Every event we emit therefore arrives
    // *nested* — behind the guard, the tags would never be read and the
    // latch half would be forwarded to whichever hook blocks CapsLock.
    if (info.flags.0 & LLKHF_INJECTED.0) != 0 {
        match info.dwExtraInfo {
            // Ordinary synthetic output: hand it down the chain like a real
            // key, so other tools' hooks still observe what we emit.
            INJECT_TAG => return CallNextHookEx(None, code, wparam, lparam),
            // The lock-latch half of a CapsLock emit. Returning 0 *without*
            // calling the next hook leaves the event on its way to win32k,
            // which flips the latch and lights the LED, while skipping every
            // hook behind ours — including any that would have eaten it.
            INJECT_TAG_LATCH => return LRESULT(0),
            // The listener half of the same emit. The rest of the chain sees
            // a CapsLock press/release pair, then we swallow it, so the
            // latch moves exactly once — from the half above — whether or
            // not anyone downstream blocked this one.
            INJECT_TAG_DECOY => {
                let _ = CallNextHookEx(None, code, wparam, lparam);
                return LRESULT(1);
            }
            _ => {}
        }
    }

    if IN_LL_PROC.with(|flag| flag.replace(true)) {
        return CallNextHookEx(None, code, wparam, lparam);
    }
    let _guard = LlProcGuard;

    let kind = match wparam.0 as u32 {
        WM_KEYDOWN | WM_SYSKEYDOWN => EventKind::KeyDown,
        WM_KEYUP | WM_SYSKEYUP => EventKind::KeyUp,
        _ => return CallNextHookEx(None, code, wparam, lparam),
    };

    // Fullscreen bypass: a marked app owning the whole screen gets the raw
    // keyboard. Checked before the modifier snapshot so a game's hot path is
    // just "same foreground HWND, still fullscreen".
    if remap_bypassed() {
        let release = {
            let mut slot = HOOK_SLOT.lock();
            match slot.as_mut() {
                // Idempotent — only the first event after the flip unwinds
                // anything. Without it a layer that was mid-chord when the
                // user alt-tabbed into the game stays logically held.
                Some(active) => active.sm.reset(),
                None => return CallNextHookEx(None, code, wparam, lparam),
            }
        };
        if !release.is_empty() {
            inject(release.as_slice());
        }
        return CallNextHookEx(None, code, wparam, lparam);
    }

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
        // Reached only for a `keys:`-side lookup — `inject` splits an
        // emitted CapsLock into its latch and listener halves before it
        // gets here. See `push_caps_emit`.
        NamedKey::CapsLock => VK_CAPITAL,
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
// Fullscreen bypass ("Disable remapping in fullscreen").
//
// A game wants the raw keyboard: Space is jump, not a hyper layer. The user
// marks an app from the Window Switcher's Ctrl+K menu, and while a window of
// that process is foreground *and* covering its monitor, the hook forwards
// everything untouched.
//
// Gating on fullscreen rather than on focus alone is deliberate: the same exe
// in a window — a launcher, a browser game, the settings screen — is an
// ordinary app where the layers are still wanted.
//
// The verdict is recomputed per key event rather than driven off a WinEvent
// hook because going fullscreen is not a foreground change: alt-enter never
// moves focus, so a hook on `EVENT_SYSTEM_FOREGROUND` would miss it. Cost on
// the hot path is one lock plus two local win32k calls; the one expensive
// step — resolving a HWND to an executable name — is cached per HWND, and an
// empty list short-circuits before any of it.

/// Executable names, lowercased, that opt into the bypass.
static BYPASS_PROCESSES: once_cell::sync::Lazy<Mutex<Vec<String>>> =
    once_cell::sync::Lazy::new(|| Mutex::new(Vec::new()));

/// Memoised `(foreground HWND, is it a marked process)`. Saves an
/// `OpenProcess` + `QueryFullProcessImageNameW` round trip on every
/// keystroke; invalidated whenever the list changes.
static BYPASS_FG_CACHE: once_cell::sync::Lazy<Mutex<Option<(isize, bool)>>> =
    once_cell::sync::Lazy::new(|| Mutex::new(None));

/// Replace the marked-process list. Independent of hook lifetime — the JS
/// side pushes the list at startup and on every edit, whether or not the
/// keyboard-remap module happens to be running.
pub(super) fn set_fullscreen_bypass_processes(names: Vec<String>) {
    let normalised: Vec<String> = names
        .into_iter()
        .map(|name| name.trim().to_ascii_lowercase())
        .filter(|name| !name.is_empty())
        .collect();
    *BYPASS_PROCESSES.lock() = normalised;
    // Whatever verdict is cached for the current foreground window was
    // computed against the old list.
    *BYPASS_FG_CACHE.lock() = None;
}

/// True while the foreground window belongs to a marked process and covers
/// its monitor.
fn remap_bypassed() -> bool {
    if BYPASS_PROCESSES.lock().is_empty() {
        return false;
    }
    let hwnd = unsafe { GetForegroundWindow() };
    if hwnd.0.is_null() {
        return false;
    }
    is_marked_process(hwnd) && covers_monitor(hwnd)
}

fn is_marked_process(hwnd: HWND) -> bool {
    let raw = hwnd.0 as isize;
    if let Some((cached_hwnd, marked)) = *BYPASS_FG_CACHE.lock() {
        if cached_hwnd == raw {
            return marked;
        }
    }

    let mut pid = 0u32;
    unsafe { GetWindowThreadProcessId(hwnd, Some(&mut pid)) };
    let marked = if pid == 0 {
        false
    } else {
        let (name, _) = crate::windows_impl::get_process_info(pid);
        let name = name.to_ascii_lowercase();
        !name.is_empty() && BYPASS_PROCESSES.lock().iter().any(|entry| entry == &name)
    };

    *BYPASS_FG_CACHE.lock() = Some((raw, marked));
    marked
}

/// Whether the window's bounds cover its monitor's full bounds. Catches
/// both exclusive fullscreen and the borderless-windowed mode most modern
/// games actually ship — the window is simply a borderless rect the size of
/// the display. Compared with `>=`/`<=` rather than equality because some
/// games overshoot the monitor rect by a pixel or two.
fn covers_monitor(hwnd: HWND) -> bool {
    unsafe {
        let mut rect = RECT::default();
        if GetWindowRect(hwnd, &mut rect).is_err() {
            return false;
        }
        let monitor = MonitorFromWindow(hwnd, MONITOR_DEFAULTTONEAREST);
        if monitor.is_invalid() {
            return false;
        }
        let mut info = MONITORINFO {
            cbSize: std::mem::size_of::<MONITORINFO>() as u32,
            ..Default::default()
        };
        if !GetMonitorInfoW(monitor, &mut info).as_bool() {
            return false;
        }
        let screen = info.rcMonitor;
        rect.left <= screen.left
            && rect.top <= screen.top
            && rect.right >= screen.right
            && rect.bottom >= screen.bottom
    }
}

// ---------------------------------------------------------------------------
// SendInput injection.

/// The lock-latch half of a CapsLock emit — reaches win32k, invisible to
/// every hook behind ours. See the `ll_proc` tag dispatch.
const INJECT_TAG_LATCH: usize = 0x52554E4C; // "RUNL"
/// The listener half of a CapsLock emit — visible to every hook behind
/// ours, never reaches win32k.
const INJECT_TAG_DECOY: usize = 0x52554E44; // "RUND"

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
            // CapsLock as an emit target has to reproduce both effects of a
            // physical press separately — see `push_caps_emit`.
            SyntheticEvent::KeyDown(NamedKey::CapsLock) => push_caps_emit(&mut inputs, true),
            SyntheticEvent::KeyUp(NamedKey::CapsLock) => push_caps_emit(&mut inputs, false),
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
            SyntheticEvent::ToggleCapsLock => {
                // Windows has no separate lock API worth reaching for —
                // tapping the key IS how the lock flips here. State only,
                // with no keystroke for anyone else to hear, so the latch
                // tag alone: nothing downstream sees it, nothing downstream
                // can block it.
                inputs.push(build_tagged_input(VK_CAPITAL, 0, INJECT_TAG_LATCH));
                inputs.push(build_tagged_input(
                    VK_CAPITAL,
                    KEYEVENTF_KEYUP.0,
                    INJECT_TAG_LATCH,
                ));
            }
            SyntheticEvent::ChangeLanguage(code) => {
                flush_inputs(&mut inputs);
                change_language(*code);
            }
            SyntheticEvent::CloseWindow => {
                flush_inputs(&mut inputs);
                close_foreground_window();
            }
        }
    }
    flush_inputs(&mut inputs);
}

/// Queue one edge of a `to_hotkey: [capslock]` emit.
///
/// A physical CapsLock does two separate things: other apps hear a key
/// press/release pair, and the OS flips the lock latch (and the LED). One
/// `SendInput` of VK_CAPITAL used to cover both — until a hook behind ours
/// started blocking CapsLock without checking `LLKHF_INJECTED`, which killed
/// the event before win32k could move the latch. The key still reached the
/// blocker, so dictation started; the LED just never came on. macOS has had
/// the two effects split all along (a CGEvent for listeners, IOKit for the
/// latch) — this is the same split expressed in hook-chain terms:
///
///   - the decoy pair brackets the combo, so a push-to-talk listener sees
///     the same held-key shape a physical press has;
///   - the latch is a complete tap on the press edge, because the lock
///     flips on key-down and leaving VK_CAPITAL logically down would strand
///     it held.
fn push_caps_emit(inputs: &mut SmallVec<[INPUT; 8]>, down: bool) {
    if down {
        inputs.push(build_tagged_input(VK_CAPITAL, 0, INJECT_TAG_DECOY));
        inputs.push(build_tagged_input(VK_CAPITAL, 0, INJECT_TAG_LATCH));
        inputs.push(build_tagged_input(
            VK_CAPITAL,
            KEYEVENTF_KEYUP.0,
            INJECT_TAG_LATCH,
        ));
    } else {
        inputs.push(build_tagged_input(
            VK_CAPITAL,
            KEYEVENTF_KEYUP.0,
            INJECT_TAG_DECOY,
        ));
    }
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

/// `close_window`: ask the foreground window to close. `WM_CLOSE` is the
/// exact message Alt+F4 and the title-bar × produce, minus the synthetic
/// keystroke — so it's a request, not a kill: apps still get to show
/// "save changes?" and to refuse. Posting rather than sending keeps the
/// hook thread out of the target app's message loop.
fn close_foreground_window() {
    let hwnd = unsafe { GetForegroundWindow() };
    if hwnd.0.is_null() {
        return;
    }
    unsafe {
        if let Err(e) = PostMessageW(hwnd, WM_CLOSE, WPARAM(0), LPARAM(0)) {
            eprintln!("[keyboard-remap] close_window: PostMessage failed: {e:?}");
        }
    }
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
    build_tagged_input(vk, flags, INJECT_TAG)
}

fn build_tagged_input(vk: VIRTUAL_KEY, flags: u32, tag: usize) -> INPUT {
    INPUT {
        r#type: INPUT_KEYBOARD,
        Anonymous: INPUT_0 {
            ki: KEYBDINPUT {
                wVk: vk,
                wScan: 0,
                dwFlags: windows::Win32::UI::Input::KeyboardAndMouse::KEYBD_EVENT_FLAGS(flags),
                time: 0,
                dwExtraInfo: tag,
            },
        },
    }
}

#[cfg(test)]
mod chain_watcher_tests {
    use super::*;

    /// The watcher is the whole of the launch-order fix, and every way it can
    /// fail is silent — an unregistered class, a rejected message-only
    /// parent, a notification API that turns out not to accept a window
    /// handle (`PowerRegisterSuspendResumeNotification` does exactly that).
    /// Nothing here would show up in behaviour except CapsLock quietly going
    /// back to whoever hooked last.
    #[test]
    fn watcher_window_and_subscriptions_install() {
        let watcher = unsafe { ChainWatcher::install() }.expect("chain watcher installs");
        assert!(!watcher.hwnd.0.is_null(), "message-only window created");
        assert_ne!(watcher.power, 0, "resume notification registered");
        unsafe { watcher.remove() };
    }
}
