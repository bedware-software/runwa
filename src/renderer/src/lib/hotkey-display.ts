/**
 * Platform-aware display of a single keyboard token.
 *
 * Sources:
 *   - Electron Accelerator strings (HotkeyRecorder, palette footer): use
 *     `Ctrl` / `Alt` / `Shift` / `Super` uniformly regardless of OS.
 *   - Main-side `rules-view.ts`: emits English names like `Cmd`, `Win`,
 *     plus named keys like `Esc`, `Enter`, `Left`.
 *
 * This util collapses both sources into per-OS display strings. On macOS
 * modifiers become menu glyphs (⌘ ⌥ ⇧ ⌃) and a handful of named keys get
 * their well-known glyphs (⎋ ⏎ ⌫ ← → etc). On Windows/Linux everything
 * stays as readable English, with `Super` / `Meta` / `Cmd` normalised to
 * `Win` (matches what the physical key is labelled).
 */

import { IS_MAC } from './platform'

const MAC_GLYPH: Record<string, string> = {
  // Modifiers
  ctrl: '⌃',
  control: '⌃',
  alt: '⌥',
  option: '⌥',
  opt: '⌥',
  shift: '⇧',
  cmd: '⌘',
  command: '⌘',
  meta: '⌘',
  // Electron's accelerator name for the Cmd key (cross-platform)
  super: '⌘',
  // `win` alias — on mac the Rust side treats win==cmd, so same glyph.
  win: '⌘',

  // Named keys with canonical macOS menu glyphs.
  escape: '⎋',
  esc: '⎋',
  tab: '⇥',
  enter: '⏎',
  return: '⏎',
  delete: '⌫',
  backspace: '⌫',
  left: '←',
  right: '→',
  up: '↑',
  down: '↓',
  home: '↖',
  end: '↘',
  pageup: '⇞',
  pgup: '⇞',
  pagedown: '⇟',
  pgdn: '⇟',
  pgdown: '⇟'
}

const WIN_LABEL: Record<string, string> = {
  // Electron accelerator uses "Super" for the Windows / Cmd key. On
  // Windows the physical key is labelled "Win" — relabel for clarity.
  super: 'Win',
  meta: 'Win',
  cmd: 'Win',
  command: 'Win'
}

/**
 * Format a single hotkey token for display on the current OS. Input is
 * case-insensitive ("ctrl", "Ctrl", "CTRL" all work); output is the
 * preferred display form (`⌃` on mac, `Ctrl` elsewhere).
 */
export function formatKey(token: string): string {
  const lower = token.toLowerCase()
  if (IS_MAC) {
    const g = MAC_GLYPH[lower]
    if (g) return g
  } else {
    const w = WIN_LABEL[lower]
    if (w) return w
  }
  return token
}

/**
 * Split a "+"-joined hotkey string into display-ready tokens for chip
 * rendering. Empty / missing input returns an empty array so callers can
 * safely `.map()` the result. Whitespace around tokens is stripped — some
 * user-authored accelerators have "Ctrl + Alt + W" style spacing.
 */
export function tokenizeHotkey(hotkey: string | undefined | null): string[] {
  if (!hotkey) return []
  return hotkey
    .split('+')
    .map((s) => s.trim())
    .filter((s) => s.length > 0)
    .map(formatKey)
}
