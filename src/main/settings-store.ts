import Store from 'electron-store'
import { EventEmitter } from 'events'
import type {
  Settings,
  ModuleId,
  ModuleSettings,
  ModuleConfigValue
} from '@shared/types'
import { DEFAULT_SETTINGS } from '@shared/types'

/**
 * Typed wrapper around electron-store. Single source of truth for settings.
 * Change events drive the hotkey-manager, module registry cache, and renderer
 * broadcasts.
 *
 * Must be .init()-ed after app.whenReady() — electron-store needs userData to
 * be resolvable, which isn't guaranteed before ready on some platforms.
 */
class SettingsStore extends EventEmitter {
  private store: Store<Settings> | null = null

  init(): void {
    if (this.store) return
    this.store = new Store<Settings>({
      name: 'runwa-settings',
      defaults: DEFAULT_SETTINGS
    })
  }

  private ensureInit(): Store<Settings> {
    if (!this.store) {
      throw new Error('SettingsStore used before init()')
    }
    return this.store
  }

  get(): Settings {
    const s = this.ensureInit()
    const stored = s.store
    return {
      ...DEFAULT_SETTINGS,
      ...stored,
      modules: { ...DEFAULT_SETTINGS.modules, ...stored.modules }
    }
  }

  patch(partial: Partial<Settings>): Settings {
    const s = this.ensureInit()
    const current = this.get()
    const next: Settings = {
      ...current,
      ...partial,
      modules: { ...current.modules, ...(partial.modules ?? {}) }
    }
    s.store = next
    this.emit('change', next)
    return next
  }

  patchModule(moduleId: ModuleId, patch: Partial<ModuleSettings>): Settings {
    const s = this.ensureInit()
    const current = this.get()
    const currentMod: ModuleSettings = current.modules[moduleId] ?? { enabled: false }
    // Merge the config bag deeply so partial updates don't clobber sibling keys.
    const mergedConfig = patch.config
      ? { ...(currentMod.config ?? {}), ...patch.config }
      : currentMod.config
    const merged: ModuleSettings = {
      ...currentMod,
      ...patch,
      ...(mergedConfig !== undefined ? { config: mergedConfig } : {})
    }
    const next: Settings = {
      ...current,
      modules: {
        ...current.modules,
        [moduleId]: merged
      }
    }
    s.store = next
    this.emit('change', next)
    return next
  }

  /** Convenience helper: merge a config patch into a module without touching other fields. */
  patchModuleConfig(
    moduleId: ModuleId,
    configPatch: Record<string, ModuleConfigValue>
  ): Settings {
    return this.patchModule(moduleId, { config: configPatch })
  }

  /**
   * Called by each module on registration. Seeds the module's entry if
   * missing, and back-fills any config keys declared on the manifest but not
   * yet stored (so upgrading runwa that adds a new config field picks up the
   * new default without wiping user choices for existing ones).
   */
  ensureModuleDefaults(moduleId: ModuleId, defaults: ModuleSettings): void {
    const current = this.get()
    const existing = current.modules[moduleId]
    if (!existing) {
      this.patchModule(moduleId, defaults)
      return
    }
    if (defaults.config) {
      const missing: Record<string, ModuleConfigValue> = {}
      for (const [key, value] of Object.entries(defaults.config)) {
        if (!(key in (existing.config ?? {}))) {
          missing[key] = value
        }
      }
      if (Object.keys(missing).length > 0) {
        this.patchModuleConfig(moduleId, missing)
      }
    }
  }
}

export const settingsStore = new SettingsStore()
