/**
 * Template written to `<userData>/keyboard-rules.yaml` on first launch.
 * Comments survive user edits; the Rust side parses this as YAML.
 *
 * Schema:
 *   Top-level keys name a physical trigger (capslock, space). Presence of
 *   the block = the trigger is active; omit it = the key behaves normally.
 *   Each trigger has a `to_hotkey` sub-block with `on_tap` and `on_hold`.
 *
 *   on_tap:   <key_name>           emit this key on a clean press-release
 *   on_tap:   [mod, ..., key]      emit a combo on tap
 *
 *   on_hold:  <modifier_name>      while held, act as that modifier
 *                                  (transparent layer)
 *   on_hold:  [<rule>, ...]        list of explicit per-combo rules; each
 *                                  rule has exactly one action field.
 *
 *   Rule schema:
 *     - description:           optional, human-readable label (ignored)
 *       platform:              optional filter: windows | macos | linux
 *       keys:                  [<trigger_key>]   single key (MVP)
 *       <exactly one action>:
 *         to_hotkey:            [mod, ..., key]    emit this key combo
 *         switch_to_workspace:  N (1-indexed)      jump to virtual desktop N (Windows only)
 *         move_to_workspace:    N (1-indexed)      move active window to VD N and follow
 *
 *   A rule with keys: [_default] + to_hotkey: [<modifier>] sets the
 *   fallback modifier for any Space+X combo that has no explicit rule.
 */
export const RULES_TEMPLATE = `# runwa keyboard rules (YAML).
# Edit and save; reload from Settings → Modules → Keyboard Remap, no app restart needed.
#
# Available tokens (case-insensitive):
#   modifiers:   ctrl alt shift cmd win  (aliases: control, option/opt, command/meta, super)
#   letters:     a-z
#   digits:      0-9
#   named:       escape(esc) space tab enter(return) delete(backspace) f1-f12
#   navigation:  left right up down home end pageup(pgup) pagedown(pgdn)
#   punctuation: literals \` - = [ ] \\ ; ' , . /  (YAML-special ones must be quoted:
#                keys: [","]  keys: ["\`"]  keys: ["\\\\"]  keys: ["["])
#                or use word aliases: backtick, minus, equals, lbracket, rbracket,
#                backslash, semicolon, quote, comma, period, slash.
#
# Each on_hold rule carries exactly ONE action:
#   to_hotkey: [mod, ..., key]      emit this key combo
#   switch_to_workspace: N          jump to virtual desktop N (Windows only, 1-indexed)
#   move_to_workspace:   N          move active window to VD N and follow (Windows only)

capslock:
  to_hotkey:
    on_tap: escape
    on_hold: ctrl

space:
  to_hotkey:
    on_tap: space
    on_hold:
      # Space+W opens the Window Switcher. Matches the direct-launch
      # hotkey you've set in Settings → Modules → Window Switcher; change
      # the RHS if you bound a different chord.
      - description: Space+W triggers the Window Switcher direct-launch hotkey
        keys: [w]
        to_hotkey: [ctrl, alt, s]

      # Vim-style arrow layer: Space+hjkl = left/down/up/right.
      - { keys: [h], to_hotkey: [left] }
      - { keys: [j], to_hotkey: [down] }
      - { keys: [k], to_hotkey: [up] }
      - { keys: [l], to_hotkey: [right] }

      # Navigation via punctuation / letters.
      - { keys: [","], to_hotkey: [home] }
      - { keys: [.],   to_hotkey: [end] }
      - { keys: [u],   to_hotkey: [pageup] }
      - { keys: [p],   to_hotkey: [pagedown] }

      # Windows: Space+Q closes the active window like Cmd+Q on macOS.
      - description: Space+Q closes the active window on Windows
        platform: windows
        keys: [q]
        to_hotkey: [alt, f4]

      # Windows: Space+backtick toggles the Quake-style Windows Terminal.
      - description: Space+\` toggles the quake terminal
        platform: windows
        keys: ["\`"]
        to_hotkey: [win, "\`"]

      # Windows virtual-desktop layer (1-indexed; Space+Shift+N moves the
      # active window to desktop N and follows it there).
      - { platform: windows, keys: [1], switch_to_workspace: 1 }
      - { platform: windows, keys: [2], switch_to_workspace: 2 }
      - { platform: windows, keys: [3], switch_to_workspace: 3 }
      - { platform: windows, keys: [4], switch_to_workspace: 4 }
      - { platform: windows, keys: [5], switch_to_workspace: 5 }

      # macOS fallback: any unmapped Space+X = Cmd+X. Gives you Space+C =
      # Cmd+C, Space+V = Cmd+V, Space+Z = Cmd+Z, etc. for free.
      - description: transparent Cmd on macOS for all unmapped combos
        platform: macos
        keys: [_default]
        to_hotkey: [cmd]
`
