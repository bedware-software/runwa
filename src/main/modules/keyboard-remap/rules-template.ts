/**
 * Template written to `<userData>/keyboard-rules.json` on first launch. The
 * Rust side parses this as JSON5, so comments survive user edits.
 */
export const RULES_TEMPLATE = `// runwa keyboard rules — JSON5 (JSON with comments).
// Edit and save; changes take effect on next runwa restart.
//
// capslock_to_ctrl_escape:
//   Hold CapsLock = Ctrl, tap CapsLock alone = Escape.
//
// space_layer:
//   Hold Space = modifier layer, tap Space alone = a regular space.
//   The layer's behaviour differs per-platform:
//     macos_transparent_modifier: any unhandled Space+X sends <mod>+X
//       (set to "cmd" so Space+C = Cmd+C, Space+V = Cmd+V, etc.)
//     windows_transparent_modifier: same idea for Windows. Default null —
//       Windows doesn't have a universal modifier that makes sense across
//       every app; add explicit overrides instead.
//
// overrides:
//   Object of { "<KEY>": { "synthesize": ["<Mod>"..., "<KEY>"] } }.
//   Suffix the key name with "_windows_only" or "_macos_only" to scope.
//   Example: Space+W triggers the Window Switcher hotkey on both platforms.
{
  "capslock_to_ctrl_escape": true,
  "space_layer": {
    "enabled": true,
    "macos_transparent_modifier": "cmd",
    "windows_transparent_modifier": null,
    "overrides": {
      // Space+W → Window Switcher direct-launch hotkey.
      // Change this to whatever hotkey you've set for window-switcher in
      // runwa settings. The default runwa install does NOT register a
      // direct-launch hotkey; bind one first in Settings → Modules →
      // Window Switcher, then copy the accelerator chord here.
      "W": { "synthesize": ["Ctrl", "Alt", "W"] },

      // Windows: Space+Q closes the active window like Cmd+Q on macOS.
      "Q_windows_only": { "synthesize": ["Alt", "F4"] }
    }
  }
}
`
