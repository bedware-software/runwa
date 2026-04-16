import { contextBridge, ipcRenderer } from 'electron'
import type {
  ElectronAPI,
  ModuleMeta,
  ModuleId,
  ModuleSettings,
  ModuleConfigValue,
  PaletteItem,
  PaletteShowPayload,
  SearchRequest,
  SearchResult,
  Settings,
  ExecuteResult
} from '@shared/types'

const api: ElectronAPI = {
  // Modules
  modulesList: (): Promise<ModuleMeta[]> => ipcRenderer.invoke('modules:list'),
  modulesSearch: (req: SearchRequest): Promise<SearchResult> =>
    ipcRenderer.invoke('modules:search', req),
  modulesCancelSearch: (requestId: number): Promise<void> =>
    ipcRenderer.invoke('modules:cancelSearch', requestId),
  modulesExecute: (item: PaletteItem): Promise<ExecuteResult> =>
    ipcRenderer.invoke('modules:execute', item),

  // Settings
  settingsGet: (): Promise<Settings> => ipcRenderer.invoke('settings:get'),
  settingsSet: (patch: Partial<Settings>): Promise<Settings> =>
    ipcRenderer.invoke('settings:set', patch),
  settingsSetModule: (
    moduleId: ModuleId,
    patch: Partial<ModuleSettings>
  ): Promise<Settings> =>
    ipcRenderer.invoke('settings:setModule', moduleId, patch),
  settingsSetModuleConfig: (
    moduleId: ModuleId,
    configPatch: Record<string, ModuleConfigValue>
  ): Promise<Settings> =>
    ipcRenderer.invoke('settings:setModuleConfig', moduleId, configPatch),

  // Palette / settings window control
  paletteHide: (): Promise<void> => ipcRenderer.invoke('palette:hide'),
  openSettings: (): Promise<void> => ipcRenderer.invoke('palette:openSettings'),

  // Signal main that the renderer has fresh results and is ready to be shown.
  paletteReady: (): void => {
    ipcRenderer.send('palette:ready')
  },

  // Palette drag-to-move — fire-and-forget so a 60Hz pointermove stream
  // doesn't pile up on an awaited IPC queue.
  paletteStartMove: (): void => {
    ipcRenderer.send('palette:startMove')
  },
  paletteMoveBy: (dx: number, dy: number): void => {
    ipcRenderer.send('palette:moveBy', dx, dy)
  },
  paletteEndMove: (): void => {
    ipcRenderer.send('palette:endMove')
  },

  // Events — return unsubscribe functions
  onPaletteShow: (cb: (payload: PaletteShowPayload) => void) => {
    const listener = (_e: Electron.IpcRendererEvent, payload: PaletteShowPayload): void => {
      cb(payload)
    }
    ipcRenderer.on('palette:show', listener)
    return () => {
      ipcRenderer.removeListener('palette:show', listener)
    }
  },

  onSettingsChanged: (cb: (settings: Settings) => void) => {
    const listener = (_e: Electron.IpcRendererEvent, settings: Settings): void => {
      cb(settings)
    }
    ipcRenderer.on('settings:changed', listener)
    return () => {
      ipcRenderer.removeListener('settings:changed', listener)
    }
  }
}

contextBridge.exposeInMainWorld('electronAPI', api)
