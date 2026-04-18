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
  private activationRegistered = false

  /** True if the current activation hotkey is live. False means another
   * app is holding the chord and the user needs to pick a different one. */
  isActivationRegistered(): boolean {
    return this.activationRegistered
  }

  init(): void {
    this.refresh(settingsStore.get())
    settingsStore.on('change', (settings: Settings) => this.refresh(settings))
  }

  private refresh(settings: Settings): void {
    this.unregisterAll()
    this.activationRegistered = false

    // 1. Activation hotkey → toggle palette
    //    (openSettingsHotkey is intentionally NOT registered globally — it's
    //    a window-local shortcut handled in the renderer, so chords like
    //    Ctrl+, don't hijack the same binding in IDEs.)
    //
    // If the user cleared the activation binding (Backspace in the
    // HotkeyRecorder persists an empty string), skip the registration
    // entirely — passing "" to Electron's globalShortcut throws a noisy
    // "conversion failure" TypeError. The downstream fallback in
    // src/main/index.ts still catches this and opens the settings window
    // so the user can rebind.
    if (settings.activationHotkey && settings.activationHotkey.trim() !== '') {
      this.activationRegistered = this.tryRegister(
        settings.activationHotkey,
        'activation',
        () => {
          paletteWindow.toggle()
        }
      )
    } else {
      console.warn(
        '[hotkey] activation hotkey is empty; skipping registration. Rebind it in Settings.'
      )
    }

    // 2. Per-module direct-launch hotkeys
    for (const [moduleId, mod] of Object.entries(settings.modules)) {
      if (!mod.enabled) continue
      const key = mod.directLaunchHotkey
      // Skip if empty (user cleared it) or whitespace-only — same reason
      // as the activation guard above.
      if (!key || key.trim() === '') continue
      // Avoid double-registering the same accelerator
      if (key === settings.activationHotkey) continue

      const module = moduleRegistry.getModule(moduleId as ModuleId)
      const hasCustomHandler = typeof module?.handleDirectLaunch === 'function'
      const wantsKeyUp =
        hasCustomHandler && module?.wantsKeyUpEvents?.() === true

      const onPress = hasCustomHandler
        ? () => module!.handleDirectLaunch!('press')
        : () => paletteWindow.show(moduleId as ModuleId)

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
