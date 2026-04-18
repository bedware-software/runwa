import { globalShortcut } from 'electron'
import type { Settings, ModuleId } from '@shared/types'
import { settingsStore } from './settings-store'
import { paletteWindow } from './palette-window'
import { moduleRegistry } from './modules/registry'
import {
  acceleratorToKeyBinding,
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
    const activationOk = this.tryRegister(
      settings.activationHotkey,
      'activation',
      () => {
        paletteWindow.toggle()
      }
    )
    this.activationRegistered = activationOk

    // 2. Per-module direct-launch hotkeys
    for (const [moduleId, mod] of Object.entries(settings.modules)) {
      if (!mod.enabled) continue
      const key = mod.directLaunchHotkey
      if (!key) continue
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
        const binding = acceleratorToKeyBinding(key)
        if (!binding) {
          console.warn(
            `[hotkey] module:${moduleId}: cannot parse "${key}" for push-to-talk; falling back to globalShortcut`
          )
          this.tryRegister(key, `module:${moduleId}`, onPress)
          continue
        }
        const onRelease = (): void => module!.handleDirectLaunch!('release')
        const ok = uiohookBridge.registerHoldToTalk(binding, onPress, onRelease)
        if (ok) {
          this.uiohookBindings.push({ binding, onPress, onRelease })
        } else {
          // uiohook-napi isn't available (failed to load / missing native
          // binary) — silently fall back to press-only. The module should
          // still be usable in its press-only branch.
          console.warn(
            `[hotkey] module:${moduleId}: uiohook unavailable; falling back to press-only via globalShortcut`
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
