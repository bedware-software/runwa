/**
 * Template written to `<userData>/keyboard-rules.yaml` on first launch.
 * Comments survive user edits; the Rust side parses this as YAML.
 *
 * Schema:
 *   Top-level keys name a physical trigger. Any recognised logical key
 *   works — the classic lock/space triggers (capslock, space), the OS
 *   modifiers (shift, ctrl, alt, cmd), side-specific modifiers
 *   (left_shift, right_shift, left_ctrl, right_ctrl, left_alt, right_alt,
 *   left_cmd/right_cmd or left_win/right_win), alpha/number keys, named keys,
 *   punctuation aliases, etc. Presence of a block = the trigger is active;
 *   omit it = the key behaves normally. Unsided modifier names keep the old
 *   behavior: either physical side can trigger/match.
 *
 *   on_tap:   [key]                press-and-release with no interruption
 *   on_tap:   [mod, ..., key]      combo on tap
 *
 *   on_tap fires only when the trigger is pressed without any external
 *   modifier already held. So `tab: on_tap: [tab]` doesn't break
 *   Cmd+Tab, Shift+Tab, Cmd+Shift+Tab, etc. — those chords pass
 *   through to the OS / app untouched. Same for `space: on_tap: [space]`
 *   and Cmd+Space (Spotlight).
 *
 *   on_hold:  [<modifier>]         while held, act as that modifier
 *                                  (transparent layer). For modifier
 *                                  triggers, an unsided transparent hold
 *                                  preserves the physical side pressed.
 *   on_hold:                       explicit per-combo rule list
 *     - { ... }
 *
 *   If on_hold is omitted for a modifier trigger (shift/ctrl/alt/cmd, sided
 *   or unsided),
 *   it defaults to a transparent layer of itself — so a shift tap rule
 *   doesn't break Shift+L for capital L.
 *
 *   Rule schema:
 *     - description:           optional, human-readable label (ignored)
 *       os:                    optional filter: windows | macos | linux
 *       keys:                  [<mods...>, <trigger_key>]  trigger key + optional
 *                                                          required physical
 *                                                          modifiers. Examples:
 *                                                            [1]              bare
 *                                                            [shift, 1]       either Shift held
 *                                                            [right_shift, 1] right Shift only
 *                                                            [ctrl, shift, 1]
 *       <exactly one action>:
 *         to_hotkey:            [mod, ..., key]    emit this key combo. Keys include the
 *                                                  named `apps` / `menu` key (Windows
 *                                                  {AppsKey} / context menu; no-op on macOS —
 *                                                  use [shift, f10] there instead).
 *         switch_to_workspace:  N (1-indexed)      jump to virtual desktop N (Windows + macOS)
 *         move_to_workspace:    N (1-indexed)      move active window to VD N and follow (Windows + macOS)
 *         change_language:      <code>             switch system input language to a code like
 *                                                  `en` or `ru`. Matches the first installed
 *                                                  input source whose language tag starts with
 *                                                  the code. Add the language in OS settings
 *                                                  first; we only activate, never install.
 *                                                  (Windows + macOS)
 *         close_window:         true                close the frontmost window — the window,
 *                                                  not the app. Windows posts WM_CLOSE (what
 *                                                  Alt+F4 sends); macOS presses the window's
 *                                                  close button via Accessibility, since it
 *                                                  has no universal shortcut for this (Cmd+Q
 *                                                  quits the app, Cmd+W closes a tab).
 *                                                  (Windows + macOS)
 *
 *   A rule with keys: [any] + to_hotkey: [<modifier>] sets the
 *   fallback modifier for any <trigger>+X combo that has no explicit rule.
 *   Exact modifier match wins over generic and bare forms: if `[1]`,
 *   `[shift, 1]`, and `[right_shift, 1]` exist, Space+1 fires the first,
 *   Space+LeftShift+1 fires `[shift, 1]`, and Space+RightShift+1 fires
 *   `[right_shift, 1]`. A qualified rule with no match falls back to the
 *   bare rule if one exists (so `keys: [w]` still fires on Shift+W).
 *
 *   Reserved top-level `settings:` block — global options, not triggers:
 *     macos_switch_workspace_modifiers: [ctrl]   macOS only. Which modifier(s)
 *                                   runwa presses alongside the desktop digit
 *                                   when firing switch_to_workspace /
 *                                   move_to_workspace. Must match your Mission
 *                                   Control "Switch to Desktop N" shortcut.
 *                                   Default [ctrl] (macOS's factory binding);
 *                                   set e.g. [ctrl, opt, cmd] if you've rebound
 *                                   it (frees plain Ctrl+number for your apps).
 */
export const RULES_TEMPLATE = `# runwa keyboard rules (YAML).
# Each on_hold rule carries exactly ONE action:
#   to_hotkey: [mod, ..., key]      emit this key combo (keys include 'apps'/'menu' =
#                                   Windows context-menu key; on macOS use [shift, f10])
#   switch_to_workspace: N          jump to virtual desktop N (1-indexed)
#   move_to_workspace:   N          move active window to VD N and follow (1-indexed)
#   change_language:     <code>     switch system input language (e.g. en, ru); the language
#                                   must already be installed as a system input source
#   close_window:        true       close the frontmost window (not the whole app): WM_CLOSE on
#                                   Windows, the window's close button via Accessibility on macOS

# Global options. macos_switch_workspace_modifiers must match your macOS
# Mission Control "Switch to Desktop N" shortcut. This template uses the
# custom [ctrl, opt, cmd] chord; change it to [ctrl] for macOS's factory binding.

settings:
  macos_switch_workspace_modifiers: [ctrl, opt, cmd]

capslock:
  on_tap: [escape]
  on_hold: [ctrl]

left_shift:
  on_tap: [ctrl, opt, cmd, a]
right_shift:
  on_tap: [ctrl, opt, cmd, w]

left_opt:
  on_tap: [f7]
right_opt:
  on_tap: [shift, f7]

tab:
  on_tap: [tab]
  on_hold:
    - { keys: [j], to_hotkey: [ctrl, tab] }
    - { keys: [k], to_hotkey: [ctrl, shift, tab] }
    - { keys: [any], to_hotkey: [ctrl, shift] }

space:
  on_tap: [space]
  on_hold:
    - { keys: [tab], to_hotkey: [ctrl, .] }
    - { keys: [\\], to_hotkey: [ctrl, b] }

    - { keys: [a], switch_to_workspace: 6 }
    - { keys: [w], to_hotkey: [ctrl, opt, cmd, w] }
    - { keys: [p], to_hotkey: [ctrl, opt, cmd, p] }
    - { keys: [f], to_hotkey: [ctrl, opt, cmd, f] }
    - { keys: [d], to_hotkey: [ctrl, opt, cmd, d] }

    - { keys: [h], to_hotkey: [left] }
    - { keys: [j], to_hotkey: [down] }
    - { keys: [k], to_hotkey: [up] }
    - { keys: [l], to_hotkey: [right] }

    - { keys: [","], to_hotkey: [home] }
    - { keys: [.], to_hotkey: [end] }

    - { os: windows, keys: [m], to_hotkey: [apps] }
    - { os: macos, keys: [m], to_hotkey: [shift, f10] }

    - { keys: [1], switch_to_workspace: 1 }
    - { keys: [2], switch_to_workspace: 2 }
    - { keys: [3], switch_to_workspace: 3 }
    - { keys: [4], switch_to_workspace: 4 }
    - { keys: [5], switch_to_workspace: 5 }
    - { keys: [6], switch_to_workspace: 6 }
    - { keys: [7], switch_to_workspace: 7 }
    - { keys: [8], switch_to_workspace: 8 }
    - { keys: [9], switch_to_workspace: 9 }
    - { keys: [0], switch_to_workspace: 10 }

    - { keys: [shift, 1], move_to_workspace: 1 }
    - { keys: [shift, 2], move_to_workspace: 2 }
    - { keys: [shift, 3], move_to_workspace: 3 }
    - { keys: [shift, 4], move_to_workspace: 4 }
    - { keys: [shift, 5], move_to_workspace: 5 }
    - { keys: [shift, 6], move_to_workspace: 6 }
    - { keys: [shift, 7], move_to_workspace: 7 }
    - { keys: [shift, 8], move_to_workspace: 8 }
    - { keys: [shift, 9], move_to_workspace: 9 }
    - { keys: [shift, 0], move_to_workspace: 10 }

    - { keys: [e], change_language: en }
    - { keys: [r], change_language: ru }

    - { keys: [q], close_window: true }
    - { os: windows, keys: ["\`"], to_hotkey: [win, "\`"] }
    - { os: macos, keys: [any], to_hotkey: [cmd] }
`
