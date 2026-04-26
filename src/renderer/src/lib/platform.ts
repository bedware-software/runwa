/**
 * Current platform identifier, matching the schema's `os` predicate
 * vocabulary (`windows | macos | linux`). Detected via `navigator.platform`
 * since the renderer doesn't have direct access to `process.platform` —
 * the values are stable across modern Chromium / Electron.
 *
 * Used by the settings UI to filter `ModuleConfigField`s with an `os`
 * filter, and by `hotkey-display.ts` to pick mac glyphs vs Windows
 * labels for chip rendering.
 */
export const CURRENT_OS: 'windows' | 'macos' | 'linux' = (() => {
  const p = navigator.platform.toLowerCase()
  if (p.includes('mac')) return 'macos'
  if (p.includes('win')) return 'windows'
  return 'linux'
})()

export const IS_MAC = CURRENT_OS === 'macos'
