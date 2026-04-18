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
 *   on_hold:  [<rule>, ...]        list of explicit per-combo rules; each:
 *             - description:  human-readable, ignored
 *               platform:     windows | macos | linux (optional filter)
 *               keys:         [<trigger_key>]   # single key (MVP)
 *               to_hotkey:    [mod, ..., key]   # what to emit
 *
 *   A rule with keys: [_default] + to_hotkey: [<modifier>] sets the
 *   fallback modifier for any Space+X combo that has no explicit rule.
 */
export const RULES_TEMPLATE = `# runwa keyboard rules (YAML).
# Edit and save; changes take effect on next runwa restart.

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

      # Windows: Space+Q closes the active window like Cmd+Q on macOS.
      - description: Space+Q closes the active window on Windows
        platform: windows
        keys: [q]
        to_hotkey: [alt, f4]

      # macOS fallback: any unmapped Space+X = Cmd+X. Gives you Space+C =
      # Cmd+C, Space+V = Cmd+V, Space+Z = Cmd+Z, etc. for free.
      - description: transparent Cmd on macOS for all unmapped combos
        platform: macos
        keys: [_default]
        to_hotkey: [cmd]
`
