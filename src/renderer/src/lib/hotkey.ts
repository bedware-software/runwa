/**
 * Convert a keyboard event into an Electron Accelerator string.
 * Returns null for lone modifier presses or unsupported keys.
 *
 * Output format matches Electron's globalShortcut: `Ctrl+Alt+W`, `Super+Alt+Space`,
 * `Shift+F5`, etc. `Super` = Windows key on Win/Linux and Command key on macOS.
 *
 * Accepted shapes:
 *   - ≥1 modifier + main key       →  `Ctrl+Alt+W`, `Shift+F5`
 *   - ≥2 modifiers, no main key    →  `Ctrl+Super`, `Alt+Shift`
 *     (WhisperFlow-style push-to-talk — needs uiohook, Electron's
 *     globalShortcut can't register these)
 *   - single "safe" non-modifier key → `F13`, `Pause`, `ScrollLock`,
 *     `PrintScreen`, `NumLock` (can't be confused with typing)
 */

const MODIFIER_KEYS = new Set(['Control', 'Alt', 'Shift', 'Meta', 'OS', 'Super'])

/** Keys that are safe to use as a single-key global hotkey without a
 *  modifier — i.e. they don't collide with typing. */
const SAFE_SINGLE_KEYS = new Set([
  'Pause',
  'ScrollLock',
  'PrintScreen',
  'NumLock',
  'F1', 'F2', 'F3', 'F4', 'F5', 'F6', 'F7', 'F8', 'F9', 'F10', 'F11', 'F12',
  'F13', 'F14', 'F15', 'F16', 'F17', 'F18', 'F19', 'F20', 'F21', 'F22', 'F23', 'F24'
])

const NAMED_KEY_MAP: Record<string, string> = {
  ArrowUp: 'Up',
  ArrowDown: 'Down',
  ArrowLeft: 'Left',
  ArrowRight: 'Right',
  ' ': 'Space',
  Spacebar: 'Space',
  Escape: 'Esc',
  Enter: 'Return',
  Tab: 'Tab',
  Backspace: 'Backspace',
  Delete: 'Delete',
  Home: 'Home',
  End: 'End',
  PageUp: 'PageUp',
  PageDown: 'PageDown',
  Insert: 'Insert',
  '+': 'Plus',
  ',': ',',
  '.': '.',
  '/': '/',
  ';': ';',
  "'": "'",
  '[': '[',
  ']': ']',
  '\\': '\\',
  '`': '`',
  '-': '-',
  '=': '='
}

function normalizeKey(key: string): string | null {
  if (MODIFIER_KEYS.has(key)) return null
  if (key.length === 1) {
    // Single character — letters, digits, punctuation
    return key.toUpperCase()
  }
  // Function keys pass through directly (F1..F24)
  if (/^F([1-9]|1[0-9]|2[0-4])$/.test(key)) return key
  return NAMED_KEY_MAP[key] ?? key
}

interface KeyboardEventLike {
  key: string
  ctrlKey: boolean
  altKey: boolean
  shiftKey: boolean
  metaKey: boolean
}

export function keyEventToAccelerator(e: KeyboardEventLike): string | null {
  const modifiers: string[] = []
  if (e.ctrlKey) modifiers.push('Ctrl')
  if (e.altKey) modifiers.push('Alt')
  if (e.shiftKey) modifiers.push('Shift')
  if (e.metaKey) modifiers.push('Super')

  const key = normalizeKey(e.key)

  // 1. No main key (user is still adjusting modifiers OR wants a
  //    modifier-only chord like Ctrl+Super). Accept with ≥2 modifiers —
  //    those chords are useful for push-to-talk but need uiohook since
  //    Electron's globalShortcut refuses to register them. A single lone
  //    modifier would hijack that key globally, so we wait for more.
  if (!key) {
    return modifiers.length >= 2 ? modifiers.join('+') : null
  }

  // 2. Main key + modifier(s): standard accelerator.
  if (modifiers.length >= 1) {
    return [...modifiers, key].join('+')
  }

  // 3. Single key, no modifiers: only allow keys that can't be confused
  //    with typing (F-keys, Pause, ScrollLock, PrintScreen, NumLock).
  //    Otherwise pressing the bound letter would trigger the hotkey
  //    every time the user types it.
  if (SAFE_SINGLE_KEYS.has(key)) {
    return key
  }

  return null
}
