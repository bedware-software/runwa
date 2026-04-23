import { createRequire } from 'node:module'

/**
 * Window-command keystroke simulator.
 *
 * The Command Palette module hides itself and hands focus back to the
 * previously-foreground window; after a short delay we fire a platform-
 * native keystroke that the OS interprets as "maximize", "minimize", or
 * "restore" the foreground window. Keystrokes instead of native API
 * calls because extending the Rust addon with per-OS window-state
 * manipulation would be significantly more work; keystrokes cover the
 * MVP and can be swapped out later without changing the module surface.
 *
 * Loaded via the same `createRequire` trick the hold-to-talk bridge
 * uses — the native addon is optional, and a missing binary degrades to
 * a logged no-op rather than crashing the module.
 */

export type WindowCommand = 'maximize' | 'minimize' | 'restore'

interface UiohookModule {
  uIOhook: {
    keyTap(key: number, modifiers?: number[]): void
  }
  UiohookKey: Record<string, number>
}

const nodeRequire = createRequire(
  typeof __filename !== 'undefined' ? __filename : import.meta.url
)

let cached: UiohookModule | null | undefined

function loadUiohook(): UiohookModule | null {
  if (cached !== undefined) return cached
  try {
    cached = nodeRequire('uiohook-napi') as UiohookModule
  } catch {
    cached = null
  }
  return cached
}

/**
 * Convert a command into a sequence of `keyTap` calls. A "sequence" is
 * used instead of a single tap so "Restore" on Windows can drive the
 * system menu (Alt+Space, R) as two sequential events — the menu
 * popping up eats a bit of time between the two taps, so a small gap
 * between them is mandatory.
 */
interface Step {
  key: number
  modifiers?: number[]
}

function stepsFor(
  command: WindowCommand,
  K: UiohookModule['UiohookKey']
): Step[] | null {
  if (process.platform === 'darwin') {
    switch (command) {
      case 'maximize':
        // Ctrl+Cmd+F toggles the native "enter full screen" on most
        // standard macOS apps. Not a pixel-perfect match for Windows
        // maximize, but the closest thing the platform ships with.
        return [{ key: K.F, modifiers: [K.Ctrl, K.Meta] }]
      case 'minimize':
        return [{ key: K.M, modifiers: [K.Meta] }]
      case 'restore':
        // Same keystroke as maximize — Ctrl+Cmd+F is a toggle on macOS,
        // so firing it again from a fullscreen state returns to the
        // windowed size.
        return [{ key: K.F, modifiers: [K.Ctrl, K.Meta] }]
    }
  }

  // Windows / Linux — both honour the Super / Windows key combos below
  // on the major window managers (WinAPI directly, Mutter/KWin/Xfwm by
  // default). Restore goes through the Alt+Space system menu on
  // Windows; on Linux the same sequence is mostly a no-op, so the
  // user-facing effect matches "not much happens" rather than a wrong
  // action. Documented limitation.
  switch (command) {
    case 'maximize':
      return [{ key: K.ArrowUp, modifiers: [K.Meta] }]
    case 'minimize':
      return [{ key: K.ArrowDown, modifiers: [K.Meta] }]
    case 'restore':
      return [
        { key: K.Space, modifiers: [K.Alt] },
        { key: K.R }
      ]
  }
}

const INTER_STEP_DELAY_MS = 60

/**
 * Fire the keystroke sequence for `command`. Returns false when the
 * native hook isn't available or the sequence can't be mapped on this
 * platform; the caller surfaces a warning.
 *
 * Sequences of length > 1 are sent with a small delay between taps so
 * the OS has time to honour the first keystroke (e.g. open the system
 * menu) before receiving the next character.
 */
export function simulateWindowCommand(command: WindowCommand): boolean {
  const mod = loadUiohook()
  if (!mod) return false
  const steps = stepsFor(command, mod.UiohookKey)
  if (!steps || steps.length === 0) return false
  try {
    const [first, ...rest] = steps
    mod.uIOhook.keyTap(first.key, first.modifiers ?? [])
    for (let i = 0; i < rest.length; i++) {
      const step = rest[i]
      setTimeout(() => {
        try {
          mod.uIOhook.keyTap(step.key, step.modifiers ?? [])
        } catch (err) {
          console.warn('[command-palette] keystroke step failed:', err)
        }
      }, INTER_STEP_DELAY_MS * (i + 1))
    }
    return true
  } catch (err) {
    console.warn('[command-palette] simulateWindowCommand failed:', err)
    return false
  }
}
