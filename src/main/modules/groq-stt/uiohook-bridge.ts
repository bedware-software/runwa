import { createRequire } from 'module'

/**
 * Thin wrapper around `uiohook-napi` that gives the hotkey manager keyup
 * events for push-to-talk bindings. Lazy-loaded so a missing native binary
 * (install failure, unsupported platform) degrades gracefully to press-only
 * via Electron's globalShortcut.
 *
 * The whole module is optional — every function returns a boolean so the
 * caller can decide what to do when uiohook isn't available.
 */

// createRequire against the module url lets us synchronously require a CJS
// native addon from an ESM/ESM-ish build without the bundler (vite) flagging
// `eval('require')` usage.
const nodeRequire = createRequire(typeof __filename !== 'undefined' ? __filename : import.meta.url)

/**
 * Parsed Electron Accelerator. `key` is the uiohook hardware keycode for the
 * main (non-modifier) key, or null for a modifier-only chord like Ctrl+Win
 * (WhisperFlow-style push-to-talk). The boolean flags describe required
 * modifier state.
 */
export interface KeyBinding {
  /** uiohook-napi keycode for the non-modifier key. Null = modifier-only
   *  chord — the press/release fires on modifier-state transitions alone. */
  key: number | null
  ctrl: boolean
  alt: boolean
  shift: boolean
  meta: boolean
}

interface UiohookKeyboardEvent {
  keycode: number
  rawcode: number
  altKey: boolean
  ctrlKey: boolean
  shiftKey: boolean
  metaKey: boolean
}

type UiohookEventName = 'keydown' | 'keyup'

interface UiohookModule {
  uIOhook: {
    on(event: UiohookEventName, listener: (e: UiohookKeyboardEvent) => void): void
    off(event: UiohookEventName, listener: (e: UiohookKeyboardEvent) => void): void
    start(): void
    stop(): void
    keyTap(key: number, modifiers?: number[]): void
  }
  UiohookKey: Record<string, number>
}

let cachedModule: UiohookModule | null | undefined
let loadError: Error | null = null
let loadAttempted = false

/** Reason the bridge couldn't register a hold-to-talk binding. Used by the
 *  hotkey manager to decide whether to log a separate user-visible message
 *  ("native hook missing") vs. a parser-level warning ("bad chord"). */
export type UiohookUnavailableReason = 'not-installed' | 'parse-failed'

/** Error message from the last failed require(). Empty string if uiohook
 *  loaded successfully or no load has been attempted yet. */
export function getLoadErrorMessage(): string {
  return loadError?.message ?? ''
}

function tryLoadUiohook(): UiohookModule | null {
  if (loadAttempted) return cachedModule ?? null
  loadAttempted = true
  try {
    // Dynamic require via a real CJS resolver so the module is truly optional
    // at runtime — if the user hasn't run `npm install` yet, or the prebuild
    // for their Electron ABI is missing, the rest of the app keeps working.
    cachedModule = nodeRequire('uiohook-napi') as UiohookModule
    // Loud, one-line confirmation so the user can tell from the log
    // whether hold-to-talk is actually wired up.
    // ASCII-only in log output so Windows consoles on non-UTF-8 codepages
    // (e.g. cp1251) don't mojibake the em dash.
    console.log('[uiohook-bridge] uiohook-napi loaded - push-to-talk enabled')
    return cachedModule
  } catch (err) {
    loadError = err as Error
    // "Cannot find module" means the package isn't in node_modules at all
    // — so the right fix is `npm install`, not `npm rebuild`. Distinguish
    // that from a runtime linker error (missing VC++ runtime, unsupported
    // glibc, etc.) which IS fixable with `npm rebuild` + a redistributable.
    const notInstalled =
      loadError.message.includes('Cannot find module') ||
      (loadError as NodeJS.ErrnoException).code === 'MODULE_NOT_FOUND'
    const hint = notInstalled
      ? 'Run `npm install` — the package is listed in package.json but not yet installed.'
      : 'Run `npm rebuild uiohook-napi`. On Windows you also need the VC++ 2015-2022 Redistributable (x64).'
    // Extra-loud so the message isn't buried under React DevTools / vite
    // noise.
    console.error(
      '\n[uiohook-bridge] ================================================================\n' +
        '[uiohook-bridge] uiohook-napi FAILED to load — push-to-talk will fall back to toggle.\n' +
        '[uiohook-bridge] Reason:',
      loadError.message,
      `\n[uiohook-bridge] Fix: ${hint}\n` +
        '[uiohook-bridge] ================================================================\n'
    )
    cachedModule = null
    return null
  }
}

/** Convenience: report whether uiohook is loaded without forcing a second
 *  require attempt. The first call triggers a require; subsequent calls
 *  just read the cached result. */
export function isUiohookAvailable(): boolean {
  return tryLoadUiohook() !== null
}

/** Map Electron Accelerator token → uiohook keycode key name. */
function keycodeFor(token: string, mod: UiohookModule): number | null {
  const K = mod.UiohookKey
  // Function keys F1..F24
  const fn = /^F(\d{1,2})$/.exec(token)
  if (fn) {
    const num = Number(fn[1])
    if (num >= 1 && num <= 24) return K[`F${num}`] ?? null
  }
  // Digits 0..9 live under numeric-string keys on uiohook-napi's enum
  // (e.g. UiohookKey[0] === 11 — there's no 'Digit0' alias).
  if (/^\d$/.test(token)) return K[token] ?? null
  // Single letter keys
  if (/^[A-Za-z]$/.test(token)) return K[token.toUpperCase()] ?? null
  // Named keys — normalize a handful of Electron synonyms to uiohook's names.
  const aliases: Record<string, string> = {
    Esc: 'Escape',
    Return: 'Enter',
    Del: 'Delete',
    Ins: 'Insert',
    PgUp: 'PageUp',
    PgDown: 'PageDown',
    Up: 'ArrowUp',
    Down: 'ArrowDown',
    Left: 'ArrowLeft',
    Right: 'ArrowRight',
    Plus: 'Equal',
    Minus: 'Minus',
    CapsLock: 'CapsLock',
    NumLock: 'NumLock',
    ScrollLock: 'ScrollLock',
    Pause: 'Pause',
    Space: 'Space',
    Tab: 'Tab',
    Backspace: 'Backspace',
    Home: 'Home',
    End: 'End',
    PrintScreen: 'PrintScreen'
  }
  const name = aliases[token] ?? token
  return K[name] ?? null
}

/**
 * Parse an Electron Accelerator (e.g. "Ctrl+Alt+Pause", "F13") into a
 * KeyBinding matched against uiohook's event shape. Returns null when the
 * accelerator has no non-modifier key or references a key uiohook doesn't
 * know about.
 */
export function acceleratorToKeyBinding(accel: string): KeyBinding | null {
  const mod = tryLoadUiohook()
  if (!mod) return null

  const parts = accel.split('+').map((p) => p.trim()).filter(Boolean)
  let ctrl = false
  let alt = false
  let shift = false
  let meta = false
  let keyToken: string | null = null

  for (const p of parts) {
    const lower = p.toLowerCase()
    if (lower === 'ctrl' || lower === 'control' || lower === 'cmdorctrl' || lower === 'commandorcontrol') {
      ctrl = true
      continue
    }
    if (lower === 'alt' || lower === 'option') {
      alt = true
      continue
    }
    if (lower === 'shift') {
      shift = true
      continue
    }
    if (lower === 'super' || lower === 'meta' || lower === 'cmd' || lower === 'command' || lower === 'win') {
      meta = true
      continue
    }
    keyToken = p
  }

  if (!keyToken) {
    // Modifier-only chord like "Ctrl+Super" or "Alt+Shift". Only allow it
    // if at least two modifiers are pressed — a single modifier alone
    // (e.g. just "Ctrl") would grab every press of that key globally.
    const modCount = (ctrl ? 1 : 0) + (alt ? 1 : 0) + (shift ? 1 : 0) + (meta ? 1 : 0)
    if (modCount < 2) return null
    return { key: null, ctrl, alt, shift, meta }
  }
  const key = keycodeFor(keyToken, mod)
  if (key == null) return null
  return { key, ctrl, alt, shift, meta }
}

/** True if the binding fires purely on modifier-state transitions — no
 *  main key. Used by the hotkey manager to skip Electron's globalShortcut
 *  (which rejects such chords with a conversion failure) and require
 *  uiohook for the binding. */
export function isModifierOnlyAccelerator(accel: string): boolean {
  const parts = accel.split('+').map((p) => p.trim()).filter(Boolean)
  if (parts.length < 2) return false
  for (const p of parts) {
    const lower = p.toLowerCase()
    const isMod =
      lower === 'ctrl' ||
      lower === 'control' ||
      lower === 'cmdorctrl' ||
      lower === 'commandorcontrol' ||
      lower === 'alt' ||
      lower === 'option' ||
      lower === 'shift' ||
      lower === 'super' ||
      lower === 'meta' ||
      lower === 'cmd' ||
      lower === 'command' ||
      lower === 'win'
    if (!isMod) return false
  }
  return true
}

/**
 * Simulate Ctrl+V (or Cmd+V on macOS) into whichever window currently has
 * keyboard focus. Used for auto-paste after a transcription lands on the
 * clipboard. No-op when uiohook-napi isn't loaded — the caller should
 * have already written to the clipboard, so the user can Ctrl+V manually
 * as a fallback.
 */
export function simulatePaste(): boolean {
  const mod = tryLoadUiohook()
  if (!mod) return false
  try {
    const ctrlKey =
      process.platform === 'darwin' ? mod.UiohookKey.Meta : mod.UiohookKey.Ctrl
    mod.uIOhook.keyTap(mod.UiohookKey.V, [ctrlKey])
    return true
  } catch (err) {
    console.warn('[uiohook-bridge] simulatePaste failed:', err)
    return false
  }
}

/**
 * Single dispatcher singleton. Starting/stopping `uIOhook` is a process-wide
 * operation, so multiple bindings share one listener pair that dispatches
 * by matching each event against every registered binding.
 */
interface BindingEntry {
  binding: KeyBinding
  onPress: () => void
  onRelease: () => void
  /** True while the chord is currently held. Used as edge-trigger memory
   *  to fire press/release exactly once per hold cycle. */
  pressed: boolean
  /** Keyed bindings only: whether the main key is currently held. Updated
   *  on every keydown/keyup of the binding's keycode so we can recompute
   *  the chord state on modifier-only events too (e.g. chord broken by
   *  an early Ctrl-up). Irrelevant for modifier-only bindings. */
  mainKeyDown: boolean
}

class UiohookBridge {
  private bindings: BindingEntry[] = []
  private rawKeydownSubscribers: Array<(e: UiohookKeyboardEvent) => void> = []
  private started = false
  private onKeyDown: ((e: UiohookKeyboardEvent) => void) | null = null
  private onKeyUp: ((e: UiohookKeyboardEvent) => void) | null = null

  registerHoldToTalk(
    binding: KeyBinding,
    onPress: () => void,
    onRelease: () => void
  ): boolean {
    const mod = tryLoadUiohook()
    if (!mod) return false

    this.bindings.push({
      binding,
      onPress,
      onRelease,
      pressed: false,
      mainKeyDown: false
    })
    this.ensureStarted(mod)
    return true
  }

  unregisterHoldToTalk(
    binding: KeyBinding,
    onPress: () => void,
    onRelease: () => void
  ): void {
    const idx = this.bindings.findIndex(
      (b) =>
        b.binding === binding && b.onPress === onPress && b.onRelease === onRelease
    )
    if (idx >= 0) {
      const entry = this.bindings[idx]
      // If the key was still held when the binding was torn down, fire the
      // release handler so downstream state (active recordings) isn't left
      // dangling.
      if (entry.pressed) {
        try {
          entry.onRelease()
        } catch {
          /* ignore */
        }
      }
      this.bindings.splice(idx, 1)
    }
    this.stopIfIdle()
  }

  /**
   * Subscribe to every raw keydown event (no chord filtering). Used by the
   * hotstrings module — it needs a running keystroke stream to match trigger
   * prefixes as the user types. Returns an unsubscribe callback.
   *
   * Calls `ensureStarted` the first time a subscriber arrives and
   * `stopIfIdle` on the last unsubscribe, so uIOhook only runs while at
   * least one consumer (binding OR raw subscriber) needs it.
   */
  subscribeKeystrokes(cb: (e: UiohookKeyboardEvent) => void): () => void {
    const mod = tryLoadUiohook()
    if (!mod) return () => {}
    this.rawKeydownSubscribers.push(cb)
    this.ensureStarted(mod)
    return () => {
      const i = this.rawKeydownSubscribers.indexOf(cb)
      if (i >= 0) this.rawKeydownSubscribers.splice(i, 1)
      this.stopIfIdle()
    }
  }

  /**
   * Simulate a short sequence of Backspace presses at the OS level. Used by
   * the hotstrings module to erase the trigger before pasting the
   * replacement. No-op when uiohook-napi isn't loaded.
   */
  simulateBackspaces(count: number): boolean {
    if (count <= 0) return true
    const mod = tryLoadUiohook()
    if (!mod) return false
    try {
      for (let i = 0; i < count; i++) {
        mod.uIOhook.keyTap(mod.UiohookKey.Backspace)
      }
      return true
    } catch (err) {
      console.warn('[uiohook-bridge] simulateBackspaces failed:', err)
      return false
    }
  }

  private ensureStarted(mod: UiohookModule): void {
    if (this.started) return
    this.onKeyDown = (e: UiohookKeyboardEvent): void => {
      for (const entry of this.bindings) {
        this.updateMainKey(entry, e, true)
        this.recomputeChord(entry, e)
      }
      // Snapshot the raw subscriber list so an in-handler unsubscribe
      // (e.g. hotstrings module ejecting itself on a disable) doesn't
      // mutate the array mid-iteration.
      for (const cb of this.rawKeydownSubscribers.slice()) {
        try {
          cb(e)
        } catch (err) {
          console.warn('[uiohook-bridge] raw keydown subscriber threw:', err)
        }
      }
    }
    this.onKeyUp = (e: UiohookKeyboardEvent): void => {
      for (const entry of this.bindings) {
        this.updateMainKey(entry, e, false)
        this.recomputeChord(entry, e)
      }
    }
    try {
      mod.uIOhook.on('keydown', this.onKeyDown)
      mod.uIOhook.on('keyup', this.onKeyUp)
      mod.uIOhook.start()
      this.started = true
    } catch (err) {
      console.warn('[uiohook-bridge] failed to start uIOhook:', err)
      // Tear down whatever did attach so we don't leak a half-started state.
      try {
        if (this.onKeyDown) mod.uIOhook.off('keydown', this.onKeyDown)
        if (this.onKeyUp) mod.uIOhook.off('keyup', this.onKeyUp)
      } catch {
        /* ignore */
      }
      this.onKeyDown = null
      this.onKeyUp = null
    }
  }

  /** Keep `mainKeyDown` in sync with physical state. No-op for modifier-only
   *  bindings, since `binding.key` is null. */
  private updateMainKey(
    entry: BindingEntry,
    e: UiohookKeyboardEvent,
    isDown: boolean
  ): void {
    if (entry.binding.key == null) return
    if (e.keycode === entry.binding.key) {
      entry.mainKeyDown = isDown
    }
  }

  /**
   * Recompute whether the chord is currently "in effect" based on the
   * event's modifier snapshot plus our tracked main-key state. Fire
   * onPress / onRelease on transitions only.
   *
   * Keyed binding: inChord = modifiers match AND main key is held.
   * Modifier-only binding: inChord = modifiers match.
   *
   * Strict modifier match: if the user binds Ctrl+F13, a stray Shift
   * press breaks the chord. Keeps the hotkey feel predictable and avoids
   * accidental triggers.
   */
  private recomputeChord(entry: BindingEntry, e: UiohookKeyboardEvent): void {
    const b = entry.binding
    const modsOk =
      b.ctrl === e.ctrlKey &&
      b.alt === e.altKey &&
      b.shift === e.shiftKey &&
      b.meta === e.metaKey
    const inChord = b.key == null ? modsOk : modsOk && entry.mainKeyDown
    if (inChord && !entry.pressed) {
      entry.pressed = true
      try {
        entry.onPress()
      } catch (err) {
        console.warn('[uiohook-bridge] onPress threw:', err)
      }
    } else if (!inChord && entry.pressed) {
      entry.pressed = false
      try {
        entry.onRelease()
      } catch (err) {
        console.warn('[uiohook-bridge] onRelease threw:', err)
      }
    }
  }

  private stop(): void {
    if (!this.started) return
    const mod = tryLoadUiohook()
    if (!mod) return
    try {
      if (this.onKeyDown) mod.uIOhook.off('keydown', this.onKeyDown)
      if (this.onKeyUp) mod.uIOhook.off('keyup', this.onKeyUp)
      mod.uIOhook.stop()
    } catch (err) {
      console.warn('[uiohook-bridge] stop failed:', err)
    }
    this.onKeyDown = null
    this.onKeyUp = null
    this.started = false
  }

  /** Tear uIOhook down once nothing needs it anymore — no bindings AND no
   *  raw keystroke subscribers. Called from every unregister path. */
  private stopIfIdle(): void {
    if (this.bindings.length === 0 && this.rawKeydownSubscribers.length === 0) {
      this.stop()
    }
  }

  dispose(): void {
    this.bindings = []
    this.rawKeydownSubscribers = []
    this.stop()
  }
}

export const uiohookBridge = new UiohookBridge()
