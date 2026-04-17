import { globalShortcut } from 'electron'
import type { Settings, ModuleId } from '@shared/types'
import { settingsStore } from './settings-store'
import { paletteWindow } from './palette-window'

/**
 * Owns all global shortcut registrations. Re-registers everything whenever
 * settings change. Silent on failure (bad hotkeys from user input are common)
 * — logs a warning so the user can fix it in settings.
 */
class HotkeyManager {
  private registered: string[] = []
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
        console.log(`[perf] t=0 activation hotkey fired`)
        ;(globalThis as { __runwaShowT0?: number }).__runwaShowT0 = Date.now()
        paletteWindow.toggle()
      }
    )
    this.activationRegistered = activationOk

    // 2. Per-module direct-launch hotkeys → open palette pre-scoped to that module
    for (const [moduleId, mod] of Object.entries(settings.modules)) {
      if (!mod.enabled) continue
      const key = mod.directLaunchHotkey
      if (!key) continue
      // Avoid double-registering the same accelerator
      if (key === settings.activationHotkey) continue
      this.tryRegister(key, `module:${moduleId}`, () => {
        paletteWindow.show(moduleId as ModuleId)
      })
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
  }

  dispose(): void {
    globalShortcut.unregisterAll()
    this.registered = []
  }
}

export const hotkeyManager = new HotkeyManager()
