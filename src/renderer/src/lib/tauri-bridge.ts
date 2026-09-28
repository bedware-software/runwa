import { invoke } from '@tauri-apps/api/core'
import { getCurrentWebviewWindow } from '@tauri-apps/api/webviewWindow'
import type {
  ElectronAPI,
  PaletteShowPayload,
  PermissionStatus,
  Settings,
  UpdateStatus
} from '@shared/types'

/**
 * `window.electronAPI` for the Tauri shell.
 *
 * The renderer only ever talks to its host through the `ElectronAPI`
 * interface, so running the same React app on Tauri means implementing that
 * interface over Tauri's IPC: each method becomes an `invoke` of the Rust
 * command with the matching name (see src-tauri/src/commands.rs), each `on…`
 * subscription a window-scoped event listener. `main.tsx` loads this module
 * only under Tauri; under Electron the preload script provides the bridge.
 *
 * Methods of modules the Rust side doesn't have yet reject with a clear
 * message; their settings panes never render, because the module list comes
 * from Rust and only contains ported modules.
 */

/** Commands reject with the Rust error string; renderer code reads `.message`. */
async function call<T>(command: string, args?: Record<string, unknown>): Promise<T> {
  try {
    return await invoke<T>(command, args)
  } catch (err) {
    throw err instanceof Error ? err : new Error(String(err))
  }
}

/** Fire-and-forget, for the 60 Hz drag stream and readiness signals. */
function fire(command: string, args?: Record<string, unknown>): void {
  invoke(command, args).catch((err: unknown) => {
    console.warn(`[tauri-bridge] ${command} failed`, err)
  })
}

function notPorted(feature: string): () => Promise<never> {
  return () =>
    Promise.reject(new Error(`${feature} is not available in the Tauri build yet.`))
}

/**
 * Listen to an event aimed at this window. `listen` resolves
 * asynchronously while the `on…` API returns its unsubscribe function
 * synchronously, so an unsubscribe that races the registration is honoured
 * once it lands. `onAttached` runs when the listener is live.
 */
function subscribe<T>(
  event: string,
  cb: (payload: T) => void,
  onAttached?: () => void
): () => void {
  let disposed = false
  let unlisten: (() => void) | undefined
  getCurrentWebviewWindow()
    .listen<T>(event, (e) => {
      if (!disposed) cb(e.payload)
    })
    .then((fn) => {
      if (disposed) {
        fn()
        return
      }
      unlisten = fn
      onAttached?.()
    })
    .catch((err: unknown) => {
      console.warn(`[tauri-bridge] listening to ${event} failed`, err)
    })
  return () => {
    disposed = true
    unlisten?.()
  }
}

/**
 * JSON can't carry `undefined`, which the renderer uses to clear a setting
 * (`{ directLaunchHotkey: undefined }`). Send `null` instead; the Rust
 * store reads it as "remove this key".
 */
function undefinedToNull(patch: object): Record<string, unknown> {
  const out: Record<string, unknown> = {}
  for (const [key, value] of Object.entries(patch)) {
    out[key] = value === undefined ? null : value
  }
  return out
}

function createTauriElectronApi(): ElectronAPI {
  return {
    getAppInfo: () => call('app_info'),

    modulesList: () => call('modules_list'),
    modulesSearch: (req) => call('modules_search', { req }),
    modulesCancelSearch: (requestId) => call('modules_cancel_search', { requestId }),
    modulesExecute: (item) => call('modules_execute', { item }),
    modulesAction: (moduleId, actionKey) => call('modules_action', { moduleId, actionKey }),

    settingsGet: () => call<Settings>('settings_get'),
    settingsSet: (patch) => call('settings_set', { patch: undefinedToNull(patch) }),
    settingsSetModule: (moduleId, patch) =>
      call('settings_set_module', { moduleId, patch: undefinedToNull(patch) }),
    settingsSetModuleConfig: (moduleId, configPatch) =>
      call('settings_set_module_config', {
        moduleId,
        configPatch: undefinedToNull(configPatch)
      }),
    settingsSetModuleAlias: (moduleId, itemId, alias) =>
      call('settings_set_module_alias', { moduleId, itemId, alias }),
    settingsSetModuleElevated: (moduleId, itemId, elevated) =>
      call('settings_set_module_elevated', { moduleId, itemId, elevated }),

    userCommandsList: notPorted('User Commands'),
    userCommandsAdd: notPorted('User Commands'),
    userCommandsUpdate: notPorted('User Commands'),
    userCommandsRemove: notPorted('User Commands'),
    userCommandsListRunningApps: notPorted('User Commands'),
    userCommandsCreateForFocusedApp: notPorted('User Commands'),

    paletteHide: () => call('palette_hide'),
    openSettings: () => call('palette_open_settings'),

    windowSwitcherCloseWindow: (item) => call('window_switcher_close_window', { item }),
    windowSwitcherIgnoreItem: (item, scope) =>
      call('window_switcher_ignore_item', { item, scope }),
    windowSwitcherListIgnoreRules: () => call('window_switcher_list_ignore_rules'),
    windowSwitcherAddIgnoreRule: (rule) => call('window_switcher_add_ignore_rule', { rule }),
    windowSwitcherRemoveIgnoreRule: (ruleId) =>
      call('window_switcher_remove_ignore_rule', { ruleId }),

    keyboardRemapFullscreenBypassItemState: (item) =>
      call('keyboard_remap_fullscreen_bypass_item_state', { item }),
    keyboardRemapFullscreenBypassToggleItem: (item) =>
      call('keyboard_remap_fullscreen_bypass_toggle_item', { item }),
    keyboardRemapListFullscreenBypass: () => call('keyboard_remap_list_fullscreen_bypass'),
    keyboardRemapRemoveFullscreenBypass: (processName) =>
      call('keyboard_remap_remove_fullscreen_bypass', { processName }),

    revealInFolder: (absolutePath) => call('reveal_in_folder', { path: absolutePath }),

    paletteReady: () => fire('palette_ready'),
    paletteStartMove: () => fire('palette_start_move'),
    paletteMoveBy: (dx, dy) => fire('palette_move_by', { dx, dy }),
    paletteEndMove: () => fire('palette_end_move'),

    keyboardRemapGetRules: notPorted('Keyboard Remap'),
    keyboardRemapReload: notPorted('Keyboard Remap'),

    flashcardsAnswer: notPorted('Flashcards'),
    flashcardsGetLlmPrompt: notPorted('Flashcards'),
    flashcardsGetDeckMastery: notPorted('Flashcards'),
    flashcardsResetDeck: notPorted('Flashcards'),

    checkForUpdates: () => Promise.resolve(),
    getUpdateStatus: () => call<UpdateStatus>('update_status'),
    onUpdateStatus: (cb) => subscribe<UpdateStatus>('app:update-status', cb),
    installUpdate: () => Promise.resolve(),

    permissionsGet: () => call<PermissionStatus>('permissions_get'),
    permissionsRequest: (name) => call<PermissionStatus>('permissions_request', { name }),
    permissionsOpenSystemSettings: (name) => call('permissions_open_system_settings', { name }),

    wipeAllData: notPorted('Wipe all data'),

    onPaletteShow: (cb) =>
      subscribe<PaletteShowPayload>('palette:show', cb, () => {
        // A show that happened while this window was still booting (the
        // palette is rebuilt on Windows desktop switches) was parked on
        // the Rust side; collect it now that someone is listening.
        call<PaletteShowPayload | null>('palette_listening')
          .then((pending) => {
            if (pending) cb(pending)
          })
          .catch((err: unknown) => {
            console.warn('[tauri-bridge] palette_listening failed', err)
          })
      }),
    onPaletteActivateSecond: (cb) => subscribe<null>('palette:activate-second', () => cb()),
    onFlashcardsStartQuiz: (cb) => subscribe('flashcards:start-quiz', cb),
    onUserCommandsDraft: (cb) => subscribe('user-commands:draft', cb),
    onWindowSwitcherIgnoreRulesChanged: (cb) =>
      subscribe('window-switcher:ignore-rules-changed', cb),
    onKeyboardRemapFullscreenBypassChanged: (cb) =>
      subscribe('keyboard-remap:fullscreen-bypass-changed', cb),
    onSettingsChanged: (cb) => subscribe<Settings>('settings:changed', cb),
    onOpenSettingsTab: (cb) => subscribe('settings:open-tab', cb)
  }
}

/** Provide `window.electronAPI` when running under Tauri. */
export function installTauriBridge(): void {
  window.electronAPI = createTauriElectronApi()
  // Mark the document so styles can account for shell differences.
  document.documentElement.setAttribute('data-shell', 'tauri')
}
