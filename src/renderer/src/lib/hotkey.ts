/**
 * Convert a keyboard event into an Electron Accelerator string.
 * Returns null for lone modifier presses or unsupported keys.
 *
 * Output format matches Electron's globalShortcut: `Ctrl+Alt+W`, `Super+Alt+Space`,
 * `Shift+F5`, etc. `Super` = Windows key on Win/Linux and Command key on macOS.
 */

const MODIFIER_KEYS = new Set(['Control', 'Alt', 'Shift', 'Meta', 'OS', 'Super'])

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
  const parts: string[] = []
  if (e.ctrlKey) parts.push('Ctrl')
  if (e.altKey) parts.push('Alt')
  if (e.shiftKey) parts.push('Shift')
  if (e.metaKey) parts.push('Super')

  const key = normalizeKey(e.key)
  if (!key) return null
  parts.push(key)

  // Require at least one modifier for global hotkeys (a lone letter isn't useful).
  if (parts.length < 2) return null

  return parts.join('+')
}
