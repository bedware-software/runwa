/**
 * uiohook keycode → typed character translation, US-QWERTY edition.
 *
 * uiohook reports the physical key that was pressed, not the character the
 * OS would translate that keypress into for the active keyboard layout.
 * There's no cross-platform way to ask "what would this keypress produce
 * under the user's active layout" without rolling a per-OS layout reader
 * (XKB on Linux, TIS on macOS, ToUnicodeEx on Windows).
 *
 * For v1 we hard-code the US-QWERTY mapping. That's enough to catch the
 * typical hotstring use case — ASCII letters, digits, and common ASCII
 * punctuation. Users on non-US layouts will see wrong characters for the
 * symbols that differ (e.g. AZERTY's shift+number row), and we eat it as
 * a known limitation. Letters and digits match on every Latin layout.
 *
 * Non-printable keys (arrows, function keys, Esc, etc.) return null —
 * callers treat those as "break the current buffer" so a hotstring trigger
 * doesn't bleed across navigation events.
 */

interface Charset {
  plain: string
  shifted: string
}

// Ordered alongside `UiohookKey` values from uiohook-napi's `dist/index.d.ts`.
// Only includes keys that produce a printable ASCII character; everything
// else (Enter, Tab, Backspace, arrows, F-keys, modifiers) is intentionally
// absent and treated as "not a character".
const KEYCODE_TO_CHARSET: Record<number, Charset> = {
  // Letters
  30: { plain: 'a', shifted: 'A' },
  48: { plain: 'b', shifted: 'B' },
  46: { plain: 'c', shifted: 'C' },
  32: { plain: 'd', shifted: 'D' },
  18: { plain: 'e', shifted: 'E' },
  33: { plain: 'f', shifted: 'F' },
  34: { plain: 'g', shifted: 'G' },
  35: { plain: 'h', shifted: 'H' },
  23: { plain: 'i', shifted: 'I' },
  36: { plain: 'j', shifted: 'J' },
  37: { plain: 'k', shifted: 'K' },
  38: { plain: 'l', shifted: 'L' },
  50: { plain: 'm', shifted: 'M' },
  49: { plain: 'n', shifted: 'N' },
  24: { plain: 'o', shifted: 'O' },
  25: { plain: 'p', shifted: 'P' },
  16: { plain: 'q', shifted: 'Q' },
  19: { plain: 'r', shifted: 'R' },
  31: { plain: 's', shifted: 'S' },
  20: { plain: 't', shifted: 'T' },
  22: { plain: 'u', shifted: 'U' },
  47: { plain: 'v', shifted: 'V' },
  17: { plain: 'w', shifted: 'W' },
  45: { plain: 'x', shifted: 'X' },
  21: { plain: 'y', shifted: 'Y' },
  44: { plain: 'z', shifted: 'Z' },
  // Digit row
  11: { plain: '0', shifted: ')' },
  2: { plain: '1', shifted: '!' },
  3: { plain: '2', shifted: '@' },
  4: { plain: '3', shifted: '#' },
  5: { plain: '4', shifted: '$' },
  6: { plain: '5', shifted: '%' },
  7: { plain: '6', shifted: '^' },
  8: { plain: '7', shifted: '&' },
  9: { plain: '8', shifted: '*' },
  10: { plain: '9', shifted: '(' },
  // Symbols
  39: { plain: ';', shifted: ':' },
  13: { plain: '=', shifted: '+' },
  51: { plain: ',', shifted: '<' },
  12: { plain: '-', shifted: '_' },
  52: { plain: '.', shifted: '>' },
  53: { plain: '/', shifted: '?' },
  41: { plain: '`', shifted: '~' },
  26: { plain: '[', shifted: '{' },
  43: { plain: '\\', shifted: '|' },
  27: { plain: ']', shifted: '}' },
  40: { plain: "'", shifted: '"' },
  // Space — typing a literal space ends most trigger matches, but we still
  // surface it here so buffers that use it as part of the trigger can
  // include it.
  57: { plain: ' ', shifted: ' ' }
}

/**
 * Map a (keycode, shift-held?) pair to the character it would produce on
 * US-QWERTY. Returns null when the key doesn't correspond to a printable
 * character (navigation, modifiers, F-keys, …).
 */
export function keycodeToChar(keycode: number, shift: boolean): string | null {
  const cs = KEYCODE_TO_CHARSET[keycode]
  if (!cs) return null
  return shift ? cs.shifted : cs.plain
}
