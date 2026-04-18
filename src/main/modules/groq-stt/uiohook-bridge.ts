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
 * main (non-modifier) key; the boolean flags describe required modifier state.
 */
export interface KeyBinding {
  /** uiohook-napi keycode for the non-modifier key, e.g. UiohookKey.Pause */
  key: number
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
    console.log('[uiohook-bridge] uiohook-napi loaded — push-to-talk enabled')
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

  if (!keyToken) return null
  const key = keycodeFor(keyToken, mod)
  if (key == null) return null
  return { key, ctrl, alt, shift, meta }
}

/**
 * Single dispatcher singleton. Starting/stopping `uIOhook` is a process-wide
 * operation, so multiple bindings share one listener pair that dispatches
 * by matching each event against every registered binding.
 */
class UiohookBridge {
  private bindings: Array<{
    binding: KeyBinding
    onPress: () => void
    onRelease: () => void
    pressed: boolean
  }> = []
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

    this.bindings.push({ binding, onPress, onRelease, pressed: false })
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
    if (this.bindings.length === 0) {
      this.stop()
    }
  }

  private ensureStarted(mod: UiohookModule): void {
    if (this.started) return
    this.onKeyDown = (e: UiohookKeyboardEvent): void => {
      for (const entry of this.bindings) {
        if (this.matches(e, entry.binding) && !entry.pressed) {
          entry.pressed = true
          try {
            entry.onPress()
          } catch (err) {
            console.warn('[uiohook-bridge] onPress threw:', err)
          }
        }
      }
    }
    this.onKeyUp = (e: UiohookKeyboardEvent): void => {
      for (const entry of this.bindings) {
        // Match the main key by keycode only on keyup — modifier state is
        // unreliable (e.g. releasing Ctrl first in "Ctrl+Pause" clears
        // ctrlKey on the subsequent Pause-up event).
        if (e.keycode === entry.binding.key && entry.pressed) {
          entry.pressed = false
          try {
            entry.onRelease()
          } catch (err) {
            console.warn('[uiohook-bridge] onRelease threw:', err)
          }
        }
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

  private matches(e: UiohookKeyboardEvent, b: KeyBinding): boolean {
    if (e.keycode !== b.key) return false
    if (b.ctrl !== e.ctrlKey) return false
    if (b.alt !== e.altKey) return false
    if (b.shift !== e.shiftKey) return false
    if (b.meta !== e.metaKey) return false
    return true
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

  dispose(): void {
    this.bindings = []
    this.stop()
  }
}

export const uiohookBridge = new UiohookBridge()
