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

/**
 * Separate bridge exposed *only* to the hidden recorder window. Kept
 * distinct from `electronAPI` so the palette / settings renderers can't
 * accidentally drive the microphone. Main gates messages by webContents.id
 * on the receiving end, so even if the palette sends these channels they'd
 * be ignored.
 */
interface RecorderAPI {
  signalReady: () => void
  sendAudio: (requestId: number, data: Uint8Array, mimeType: string) => void
  sendError: (requestId: number, message: string) => void
  onStart: (cb: (payload: { requestId: number }) => void) => () => void
  onStop: (cb: () => void) => () => void
}

const recorderApi: RecorderAPI = {
  signalReady: () => {
    ipcRenderer.send('groq-stt:recorder:ready')
  },
  sendAudio: (requestId, data, mimeType) => {
    ipcRenderer.send('groq-stt:recorder:audio', { requestId, data, mimeType })
  },
  sendError: (requestId, message) => {
    ipcRenderer.send('groq-stt:recorder:error', { requestId, message })
  },
  onStart: (cb) => {
    const listener = (
      _e: Electron.IpcRendererEvent,
      payload: { requestId: number }
    ): void => {
      cb(payload)
    }
    ipcRenderer.on('groq-stt:recorder:start', listener)
    return () => {
      ipcRenderer.removeListener('groq-stt:recorder:start', listener)
    }
  },
  onStop: (cb) => {
    const listener = (): void => {
      cb()
    }
    ipcRenderer.on('groq-stt:recorder:stop', listener)
    return () => {
      ipcRenderer.removeListener('groq-stt:recorder:stop', listener)
    }
  }
}

contextBridge.exposeInMainWorld('groqRecorder', recorderApi)

/** Bridge for the small recording-indicator window. */
type GroqIndicatorState = 'hidden' | 'recording' | 'transcribing'

interface IndicatorAPI {
  signalReady: () => void
  onState: (cb: (state: GroqIndicatorState) => void) => () => void
}

const indicatorApi: IndicatorAPI = {
  signalReady: () => {
    ipcRenderer.send('groq-stt:indicator:ready')
  },
  onState: (cb) => {
    const listener = (
      _e: Electron.IpcRendererEvent,
      state: GroqIndicatorState
    ): void => {
      cb(state)
    }
    ipcRenderer.on('groq-stt:indicator:state', listener)
    return () => {
      ipcRenderer.removeListener('groq-stt:indicator:state', listener)
    }
  }
}

contextBridge.exposeInMainWorld('groqIndicator', indicatorApi)
