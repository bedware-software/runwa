import { create } from 'zustand'
import { immer } from 'zustand/middleware/immer'
import type {
  ModuleConfigValue,
  ModuleId,
  ModuleMeta,
  Settings,
  Theme
} from '@shared/types'

interface SettingsState {
  settings: Settings | null
  modules: ModuleMeta[]
  isHydrated: boolean

  hydrate: () => Promise<void>
  setTheme: (theme: Theme) => Promise<void>
  setActivationHotkey: (hotkey: string) => Promise<void>
  setOpenSettingsHotkey: (hotkey: string) => Promise<void>
  setModuleEnabled: (moduleId: ModuleId, enabled: boolean) => Promise<void>
  setModuleHotkey: (
    moduleId: ModuleId,
    hotkey: string | undefined
  ) => Promise<void>
  setModuleConfig: (
    moduleId: ModuleId,
    configPatch: Record<string, ModuleConfigValue>
  ) => Promise<void>
  setModuleAlias: (
    moduleId: ModuleId,
    itemId: string,
    alias: string | null
  ) => Promise<void>
  applyServerSettings: (settings: Settings) => void
}

export const useSettingsStore = create<SettingsState>()(
  immer((set) => ({
    settings: null,
    modules: [],
    isHydrated: false,

    hydrate: async () => {
      const [settings, modules] = await Promise.all([
        window.electronAPI.settingsGet(),
        window.electronAPI.modulesList()
      ])
      set((s) => {
        s.settings = settings
        s.modules = modules
        s.isHydrated = true
      })
    },

    setTheme: async (theme: Theme) => {
      const updated = await window.electronAPI.settingsSet({ theme })
      set((s) => {
        s.settings = updated
      })
    },

    setActivationHotkey: async (hotkey: string) => {
      const updated = await window.electronAPI.settingsSet({
        activationHotkey: hotkey
      })
      set((s) => {
        s.settings = updated
      })
    },

    setOpenSettingsHotkey: async (hotkey: string) => {
      const updated = await window.electronAPI.settingsSet({
        openSettingsHotkey: hotkey
      })
      set((s) => {
        s.settings = updated
      })
    },

    setModuleEnabled: async (moduleId: ModuleId, enabled: boolean) => {
      const updated = await window.electronAPI.settingsSetModule(moduleId, {
        enabled
      })
      set((s) => {
        s.settings = updated
        const idx = s.modules.findIndex((m) => m.id === moduleId)
        if (idx >= 0) {
          s.modules[idx].enabled = enabled
        }
      })
    },

    setModuleHotkey: async (
      moduleId: ModuleId,
      hotkey: string | undefined
    ) => {
      const updated = await window.electronAPI.settingsSetModule(moduleId, {
        directLaunchHotkey: hotkey
      })
      set((s) => {
        s.settings = updated
        const idx = s.modules.findIndex((m) => m.id === moduleId)
        if (idx >= 0) {
          s.modules[idx].directLaunchHotkey = hotkey
        }
      })
    },

    setModuleAlias: async (
      moduleId: ModuleId,
      itemId: string,
      alias: string | null
    ) => {
      const updated = await window.electronAPI.settingsSetModuleAlias(
        moduleId,
        itemId,
        alias
      )
      set((s) => {
        s.settings = updated
        const idx = s.modules.findIndex((m) => m.id === moduleId)
        if (idx < 0) return
        const mod = s.modules[idx]
        const aliases = { ...(mod.aliases ?? {}) }
        const normalised = typeof alias === 'string' ? alias.trim().toLowerCase() : ''
        if (normalised.length === 0) {
          delete aliases[itemId]
        } else {
          aliases[itemId] = normalised
        }
        mod.aliases = aliases
      })
    },

    setModuleConfig: async (
      moduleId: ModuleId,
      configPatch: Record<string, ModuleConfigValue>
    ) => {
      const updated = await window.electronAPI.settingsSetModuleConfig(
        moduleId,
        configPatch
      )
      set((s) => {
        s.settings = updated
        const idx = s.modules.findIndex((m) => m.id === moduleId)
        if (idx >= 0) {
          s.modules[idx].config = {
            ...s.modules[idx].config,
            ...configPatch
          }
        }
      })
    },

    applyServerSettings: (settings: Settings) => {
      set((s) => {
        s.settings = settings
      })
    }
  }))
)
