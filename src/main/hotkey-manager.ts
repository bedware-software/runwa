import { globalShortcut } from 'electron'
import type { Settings, ModuleId } from '@shared/types'
import { settingsStore } from './settings-store'
import { paletteWindow } from './palette-window'
import { moduleRegistry } from './modules/registry'
import {
  acceleratorToKeyBinding,
  getLoadErrorMessage,
  isUiohookAvailable,
  uiohookBridge,
  type KeyBinding
} from './modules/groq-stt/uiohook-bridge'

const MODIFIER_TOKENS = new Set([
  'ctrl',
  'control',
  'cmdorctrl',
  'commandorcontrol',
  'alt',
  'option',
  'shift',
  'super',
  'meta',
  'cmd',
  'command',
  'win'
])

/**
 * True if the accelerator is exactly two-or-more modifiers with no
 * non-modifier key. Modifier-only chords used to be accepted (routed
 * through uiohook for WhisperFlow-style push-to-talk) but were too
 * easy to trigger by accident — any synthetic chord from
 * keyboard-remap that briefly held the same modifiers would fire them.
 * We keep this detector around to print a friendly migration warning
 * when a user has a legacy modifier-only chord stored in their
 * settings.json from a previous version.
 */
function looksModifierOnly(accel: string): boolean {
  const parts = accel
    .split('+')
    .map((p) => p.trim().toLowerCase())
    .filter(Boolean)
  if (parts.length < 2) return false
  return parts.every((p) => MODIFIER_TOKENS.has(p))
}

/**
 * Owns all global shortcut registrations. Re-registers everything whenever
 * settings change. Silent on failure (bad hotkeys from user input are common)
 * — logs a warning so the user can fix it in settings.
 *
 * Two registration paths:
 *   1. Electron's `globalShortcut` — key-down only. Default path.
 *   2. uiohook-napi — gives both key-down and key-up. Used only when a module
 *      opts in via `wantsKeyUpEvents()` (push-to-talk).
 */
class HotkeyManager {
  private registered: string[] = []
  private uiohookBindings: Array<{
    binding: KeyBinding
    onPress: () => void
    onRelease: () => void
  }> = []

  init(): void {
    this.refresh(settingsStore.get())
    settingsStore.on('change', (settings: Settings) => this.refresh(settings))
  }

  private refresh(settings: Settings): void {
    this.unregisterAll()

    // Per-module direct-launch hotkeys. There is no aggregate "open palette"
    // chord any more — every entry into the palette names its own module.
    for (const [moduleId, mod] of Object.entries(settings.modules)) {
      if (!mod.enabled) continue
      const key = mod.directLaunchHotkey
      // Skip if empty (user cleared it) or whitespace-only — passing "" to
      // Electron's globalShortcut throws a noisy "conversion failure" error.
      if (!key || key.trim() === '') continue

      const module = moduleRegistry.getModule(moduleId as ModuleId)
      const hasCustomHandler = typeof module?.handleDirectLaunch === 'function'
      const wantsKeyUp =
        hasCustomHandler && module?.wantsKeyUpEvents?.() === true

      const onPress = hasCustomHandler
        ? () => module!.handleDirectLaunch!('press')
        : () =>
            paletteWindow.toggle(
              moduleId as ModuleId,
              module?.manifest.directLaunchSecondPress
            )

      // Modifier-only chords (`Ctrl+Super`, `Alt+Shift`, …) are no
      // longer accepted — they used to route through uiohook for
      // WhisperFlow-style push-to-talk but were too easy to trigger
      // by accident: any synthetic chord with the same modifier
      // prefix (e.g. keyboard-remap emitting `Ctrl+Alt+Cmd+W`)
      // brushed them mid-emission. Warn the user with an explicit
      // migration hint and skip the binding so they're not confused
      // by a silent failure.
      if (looksModifierOnly(key)) {
        console.warn(
          `[hotkey] module:${moduleId}: modifier-only hotkey "${key}" is no longer supported — too easy to trigger by accident. Rebind to a chord that includes a regular key (e.g. Ctrl+Alt+Super+D) or a function key (F13–F19) in Settings.`
        )
        continue
      }

      if (wantsKeyUp) {
        // Distinguish "the native key-hook library is missing" (common on
        // Windows without the VC++ runtime, on Linux with a permissions
        // mismatch, etc.) from "the accelerator itself can't be parsed".
        // Both cases fall back to press-only via globalShortcut — and the
        // module's press handler degrades to toggle in that case — but
        // the log should make it clear *why* hold-to-talk isn't active
        // so the user can fix the install instead of assuming a bug.
        if (!isUiohookAvailable()) {
          console.warn(
            `[hotkey] module:${moduleId}: push-to-talk requested but uiohook-napi is not loaded (${
              getLoadErrorMessage() || 'unknown reason'
            }). Falling back to toggle via globalShortcut.`
          )
          this.tryRegister(key, `module:${moduleId}`, onPress)
          continue
        }
        const binding = acceleratorToKeyBinding(key)
        if (!binding) {
          console.warn(
            `[hotkey] module:${moduleId}: cannot parse "${key}" for push-to-talk; falling back to toggle via globalShortcut`
          )
          this.tryRegister(key, `module:${moduleId}`, onPress)
          continue
        }
        const onRelease = (): void => module!.handleDirectLaunch!('release')
        const ok = uiohookBridge.registerHoldToTalk(binding, onPress, onRelease)
        if (ok) {
          this.uiohookBindings.push({ binding, onPress, onRelease })
        } else {
          console.warn(
            `[hotkey] module:${moduleId}: uiohook refused to start; falling back to toggle via globalShortcut`
          )
          this.tryRegister(key, `module:${moduleId}`, onPress)
        }
      } else {
        this.tryRegister(key, `module:${moduleId}`, onPress)
      }
    }
  }

  private tryRegister(accelerator: string, label: string, handler: () => void): boolean {
    try {
      const ok = globalShortcut.register(accelerator, handler)
      if (ok) {
        this.registered.push(accelerator)
        return true
      }
      console.warn(
        `[hotkey] ${label}: registration returned false for "${accelerator}" - another app may own this chord`
      )
      return false
    } catch (err) {
      console.warn(`[hotkey] ${label}: threw while registering "${accelerator}"`, err)
      return false
    }
  }

  private unregisterAll(): void {
    for (const key of this.registered) {
      try {
        globalShortcut.unregister(key)
      } catch {
        // ignore
      }
    }
    this.registered = []
    for (const b of this.uiohookBindings) {
      uiohookBridge.unregisterHoldToTalk(b.binding, b.onPress, b.onRelease)
    }
    this.uiohookBindings = []
  }

  dispose(): void {
    globalShortcut.unregisterAll()
    this.registered = []
    uiohookBridge.dispose()
  }
}

export const hotkeyManager = new HotkeyManager()
