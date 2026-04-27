/**
 * Template written to `<userData>/keyboard-rules.yaml` on first launch.
 * Comments survive user edits; the Rust side parses this as YAML.
 *
 * Schema:
 *   Top-level keys name a physical trigger. Any recognised logical key
 *   works — the classic lock/space triggers (capslock, space), the OS
 *   modifiers (shift, ctrl, alt, cmd), alpha/number keys, named keys,
 *   punctuation aliases, etc. Presence of a block = the trigger is
 *   active; omit it = the key behaves normally.
 *
 *   on_tap:   [key]                press-and-release with no interruption
 *   on_tap:   [mod, ..., key]      combo on tap
 *
 *   on_hold:  [<modifier>]         while held, act as that modifier
 *                                  (transparent layer)
 *   on_hold:                       explicit per-combo rule list
 *     - { ... }
 *
 *   If on_hold is omitted for a modifier trigger (shift/ctrl/alt/cmd),
 *   it defaults to a transparent layer of itself — so a shift tap rule
 *   doesn't break Shift+L for capital L.
 *
 *   Rule schema:
 *     - description:           optional, human-readable label (ignored)
 *       os:                    optional filter: windows | macos | linux
 *       keys:                  [<mods...>, <trigger_key>]  trigger key + optional
 *                                                          required physical
 *                                                          modifiers. Examples:
 *                                                            [1]           bare
 *                                                            [shift, 1]    Shift held
 *                                                            [ctrl, shift, 1]
 *       <exactly one action>:
 *         to_hotkey:            [mod, ..., key]    emit this key combo
 *         switch_to_workspace:  N (1-indexed)      jump to virtual desktop N (Windows + macOS)
 *         move_to_workspace:    N (1-indexed)      move active window to VD N and follow (Windows + macOS)
 *
 *   A rule with keys: [any] + to_hotkey: [<modifier>] sets the
 *   fallback modifier for any <trigger>+X combo that has no explicit rule.
 *   Exact modifier match wins over the bare form: if both `[1]` and
 *   `[shift, 1]` exist, Space+1 fires the first and Space+Shift+1 fires
 *   the second. A qualified rule with no match falls back to the bare
 *   rule if one exists (so `keys: [w]` still fires on Shift+W).
 */
export const RULES_TEMPLATE = `# runwa keyboard rules (YAML).
# Each on_hold rule carries exactly ONE action:
#   to_hotkey: [mod, ..., key]      emit this key combo
#   switch_to_workspace: N          jump to virtual desktop N (1-indexed)
#   move_to_workspace:   N          move active window to VD N and follow (1-indexed)

capslock:
  on_tap: [escape]
  on_hold: [ctrl]

shift:
  on_tap: [cmd, space]

tab
  on_tap: [ctrl, alt, a]
  on_hold:
    - { keys: [j], to_hotkey: [ctrl, tab] }
    - { keys: [k], to_hotkey: [ctrl, shift, tab] }

space:
  on_tap: [space]
  on_hold:
    - { keys: [w], to_hotkey: [ctrl, alt, w] }
    - { keys: [a], to_hotkey: [ctrl, alt, a] }
    - { keys: [p], to_hotkey: [ctrl, alt, p] }

    - { keys: [h], to_hotkey: [left] }
    - { keys: [j], to_hotkey: [down] }
    - { keys: [k], to_hotkey: [up] }
    - { keys: [l], to_hotkey: [right] }

    - { keys: [","], to_hotkey: [home] }
    - { keys: [.],   to_hotkey: [end] }

    - { keys: [1], switch_to_workspace: 1 }
    - { keys: [2], switch_to_workspace: 2 }
    - { keys: [3], switch_to_workspace: 3 }
    - { keys: [4], switch_to_workspace: 4 }
    - { keys: [5], switch_to_workspace: 5 }
    - { keys: [6], switch_to_workspace: 6 }
    - { keys: [7], switch_to_workspace: 7 }
    - { keys: [8], switch_to_workspace: 8 }
    - { keys: [9], switch_to_workspace: 9 }

    - { keys: [shift, 1], move_to_workspace: 1 }
    - { keys: [shift, 2], move_to_workspace: 2 }
    - { keys: [shift, 3], move_to_workspace: 3 }
    - { keys: [shift, 4], move_to_workspace: 4 }
    - { keys: [shift, 5], move_to_workspace: 5 }
    - { keys: [shift, 6], move_to_workspace: 6 }
    - { keys: [shift, 7], move_to_workspace: 7 }
    - { keys: [shift, 8], move_to_workspace: 8 }
    - { keys: [shift, 9], move_to_workspace: 9 }

    - { os: windows, keys: [q], to_hotkey: [alt, f4] }
    - { os: windows, keys: ["\`"], to_hotkey: [win, "\`"] }
    - { os: macos, keys: [any], to_hotkey: [cmd] }
`
