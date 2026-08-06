import { contextBridge, ipcRenderer } from 'electron'
import type {
  AppInfo,
  DesktopHintPayload,
  ElectronAPI,
  FlashcardAnswerRequest,
  FlashcardCardState,
  FlashcardsDeckMastery,
  FlashcardsLlmPromptView,
  FlashcardsStartQuizPayload,
  KeyboardRemapRulesView,
  ModuleMeta,
  ModuleId,
  ModuleSettings,
  ModuleConfigValue,
  NewFocusedAppCommand,
  NewUserCommand,
  NewWindowIgnoreRule,
  PaletteItem,
  PaletteShowPayload,
  PermissionName,
  PermissionStatus,
  RunningAppSummary,
  SearchRequest,
  SearchResult,
  Settings,
  SettingsTabId,
  UserCommand,
  UserCommandDraftPayload,
  ExecuteResult,
  UpdateStatus,
  WindowIgnoreRule,
  WindowIgnoreScope
} from '@shared/types'

const api: ElectronAPI = {
  // Environment snapshot (packaged? platform?).
  getAppInfo: (): Promise<AppInfo> => ipcRenderer.invoke('app:info'),

  // Modules
  modulesList: (): Promise<ModuleMeta[]> => ipcRenderer.invoke('modules:list'),
  modulesSearch: (req: SearchRequest): Promise<SearchResult> =>
    ipcRenderer.invoke('modules:search', req),
  modulesCancelSearch: (requestId: number): Promise<void> =>
    ipcRenderer.invoke('modules:cancelSearch', requestId),
  modulesExecute: (item: PaletteItem): Promise<ExecuteResult> =>
    ipcRenderer.invoke('modules:execute', item),
  modulesAction: (moduleId: ModuleId, actionKey: string): Promise<void> =>
    ipcRenderer.invoke('modules:action', moduleId, actionKey),

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
  settingsSetModuleAlias: (
    moduleId: ModuleId,
    itemId: string,
    alias: string | null
  ): Promise<Settings> =>
    ipcRenderer.invoke('settings:setModuleAlias', moduleId, itemId, alias),

  // User Commands
  userCommandsList: (): Promise<UserCommand[]> =>
    ipcRenderer.invoke('user-commands:list'),
  userCommandsAdd: (command: NewUserCommand): Promise<UserCommand[]> =>
    ipcRenderer.invoke('user-commands:add', command),
  userCommandsUpdate: (
    commandId: string,
    command: NewUserCommand
  ): Promise<UserCommand[]> =>
    ipcRenderer.invoke('user-commands:update', commandId, command),
  userCommandsRemove: (commandId: string): Promise<UserCommand[]> =>
    ipcRenderer.invoke('user-commands:remove', commandId),
  userCommandsListRunningApps: (): Promise<RunningAppSummary[]> =>
    ipcRenderer.invoke('user-commands:running-apps'),
  userCommandsCreateForFocusedApp: (
    command: NewFocusedAppCommand
  ): Promise<string> =>
    ipcRenderer.invoke('user-commands:create-for-focused-app', command),

  // Palette / settings window control
  paletteHide: (): Promise<void> => ipcRenderer.invoke('palette:hide'),
  openSettings: (): Promise<void> => ipcRenderer.invoke('palette:openSettings'),

  // Window-switcher: close the OS window behind a palette row (Ctrl/Cmd+D).
  windowSwitcherCloseWindow: (item: PaletteItem): Promise<boolean> =>
    ipcRenderer.invoke('window-switcher:close-window', item),

  // Window-switcher ignore list — palette-side (derive a rule from a row)
  // plus the Settings-side management trio.
  windowSwitcherIgnoreItem: (
    item: PaletteItem,
    scope: WindowIgnoreScope
  ): Promise<boolean> =>
    ipcRenderer.invoke('window-switcher:ignore-item', item, scope),
  windowSwitcherListIgnoreRules: (): Promise<WindowIgnoreRule[]> =>
    ipcRenderer.invoke('window-switcher:ignore-rules:list'),
  windowSwitcherAddIgnoreRule: (
    rule: NewWindowIgnoreRule
  ): Promise<WindowIgnoreRule[]> =>
    ipcRenderer.invoke('window-switcher:ignore-rules:add', rule),
  windowSwitcherRemoveIgnoreRule: (ruleId: string): Promise<WindowIgnoreRule[]> =>
    ipcRenderer.invoke('window-switcher:ignore-rules:remove', ruleId),

  // Context-menu target: `shell.showItemInFolder(absolutePath)` on main.
  revealInFolder: (absolutePath: string): Promise<void> =>
    ipcRenderer.invoke('app:reveal-in-folder', absolutePath),

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

  // Keyboard remap — module-specific surface for the settings panel
  keyboardRemapGetRules: (): Promise<KeyboardRemapRulesView> =>
    ipcRenderer.invoke('keyboard-remap:getRules'),
  keyboardRemapReload: (): Promise<KeyboardRemapRulesView> =>
    ipcRenderer.invoke('keyboard-remap:reload'),

  // Flashcards — record an answer and get the new SRS state back.
  flashcardsAnswer: (req: FlashcardAnswerRequest): Promise<FlashcardCardState> =>
    ipcRenderer.invoke('flashcards:answer', req),
  flashcardsGetLlmPrompt: (): Promise<FlashcardsLlmPromptView> =>
    ipcRenderer.invoke('flashcards:get-llm-prompt'),
  flashcardsGetDeckMastery: (deckId: string): Promise<FlashcardsDeckMastery> =>
    ipcRenderer.invoke('flashcards:get-deck-mastery', deckId),
  flashcardsResetDeck: (deckId: string): Promise<void> =>
    ipcRenderer.invoke('flashcards:reset-deck', deckId),

  // Auto-update: trigger a check + poll current state. Push updates
  // stream over the `app:update-status` channel via the subscription
  // helper below.
  checkForUpdates: (): Promise<void> =>
    ipcRenderer.invoke('app:checkForUpdates'),
  getUpdateStatus: (): Promise<UpdateStatus> =>
    ipcRenderer.invoke('app:getUpdateStatus'),
  onUpdateStatus: (cb: (status: UpdateStatus) => void) => {
    const listener = (_e: Electron.IpcRendererEvent, status: UpdateStatus): void => {
      cb(status)
    }
    ipcRenderer.on('app:update-status', listener)
    return () => {
      ipcRenderer.removeListener('app:update-status', listener)
    }
  },
  installUpdate: (): Promise<void> => ipcRenderer.invoke('app:installUpdate'),

  // macOS permissions — null on non-macOS platforms.
  permissionsGet: (): Promise<PermissionStatus> =>
    ipcRenderer.invoke('permissions:get'),
  permissionsRequest: (name: PermissionName): Promise<PermissionStatus> =>
    ipcRenderer.invoke('permissions:request', name),
  permissionsOpenSystemSettings: (name: PermissionName): Promise<void> =>
    ipcRenderer.invoke('permissions:openSystemSettings', name),

  // Danger zone: wipe the entire userData directory and relaunch.
  wipeAllData: (): Promise<void> => ipcRenderer.invoke('app:wipe-data'),

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

  onPaletteActivateSecond: (cb: () => void) => {
    const listener = (): void => {
      cb()
    }
    ipcRenderer.on('palette:activate-second', listener)
    return () => {
      ipcRenderer.removeListener('palette:activate-second', listener)
    }
  },

  onWindowSwitcherIgnoreRulesChanged: (cb: (rules: WindowIgnoreRule[]) => void) => {
    const listener = (
      _e: Electron.IpcRendererEvent,
      rules: WindowIgnoreRule[]
    ): void => {
      cb(rules)
    }
    ipcRenderer.on('window-switcher:ignore-rules-changed', listener)
    return () => {
      ipcRenderer.removeListener('window-switcher:ignore-rules-changed', listener)
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
  },

  onOpenSettingsTab: (cb: (tab: SettingsTabId) => void) => {
    const listener = (_e: Electron.IpcRendererEvent, tab: SettingsTabId): void => {
      cb(tab)
    }
    ipcRenderer.on('settings:open-tab', listener)
    return () => {
      ipcRenderer.removeListener('settings:open-tab', listener)
    }
  },

  onFlashcardsStartQuiz: (cb: (payload: FlashcardsStartQuizPayload) => void) => {
    const listener = (
      _e: Electron.IpcRendererEvent,
      payload: FlashcardsStartQuizPayload
    ): void => {
      cb(payload)
    }
    ipcRenderer.on('flashcards:start-quiz', listener)
    return () => {
      ipcRenderer.removeListener('flashcards:start-quiz', listener)
    }
  },

  onUserCommandsDraft: (cb: (payload: UserCommandDraftPayload) => void) => {
    const listener = (
      _e: Electron.IpcRendererEvent,
      payload: UserCommandDraftPayload
    ): void => {
      cb(payload)
    }
    ipcRenderer.on('user-commands:draft', listener)
    return () => {
      ipcRenderer.removeListener('user-commands:draft', listener)
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

/** Bridge for the shared, focusless Desktop Hint window. */
interface DesktopHintAPI {
  signalReady: () => void
  onPayload: (
    cb: (payload: DesktopHintPayload | null) => void
  ) => () => void
}

const desktopHintApi: DesktopHintAPI = {
  signalReady: () => {
    ipcRenderer.send('desktop-hint:ready')
  },
  onPayload: (cb) => {
    const listener = (
      _e: Electron.IpcRendererEvent,
      payload: DesktopHintPayload | null
    ): void => {
      cb(payload)
    }
    ipcRenderer.on('desktop-hint:payload', listener)
    return () => {
      ipcRenderer.removeListener('desktop-hint:payload', listener)
    }
  }
}

contextBridge.exposeInMainWorld('desktopHint', desktopHintApi)
