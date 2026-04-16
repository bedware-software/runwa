import { ipcMain } from 'electron'
import type {
  SearchRequest,
  PaletteItem,
  Settings,
  ModuleId,
  ModuleSettings,
  ModuleConfigValue
} from '@shared/types'
import { settingsStore } from '../settings-store'
import { moduleRegistry } from '../modules/registry'
import { paletteWindow } from '../palette-window'
import { settingsWindow } from '../settings-window'

export function registerIpcHandlers(): void {
  // Modules
  ipcMain.handle('modules:list', async () => moduleRegistry.getManifests())

  ipcMain.handle('modules:search', async (_e, req: SearchRequest) =>
    moduleRegistry.search(req)
  )

  ipcMain.handle('modules:cancelSearch', async (_e, requestId: number) => {
    moduleRegistry.cancelSearch(requestId)
  })

  ipcMain.handle('modules:execute', async (_e, item: PaletteItem) => {
    const result = await moduleRegistry.execute(item)
    if (result.dismissPalette) {
      paletteWindow.hide()
    }
    return result
  })

  // Settings
  ipcMain.handle('settings:get', async () => settingsStore.get())

  ipcMain.handle('settings:set', async (_e, patch: Partial<Settings>) =>
    settingsStore.patch(patch)
  )

  ipcMain.handle(
    'settings:setModule',
    async (_e, moduleId: ModuleId, patch: Partial<ModuleSettings>) =>
      settingsStore.patchModule(moduleId, patch)
  )

  ipcMain.handle(
    'settings:setModuleConfig',
    async (
      _e,
      moduleId: ModuleId,
      configPatch: Record<string, ModuleConfigValue>
    ) => settingsStore.patchModuleConfig(moduleId, configPatch)
  )

  // Palette / settings window control
  ipcMain.handle('palette:hide', async () => {
    paletteWindow.hide(true)
  })

  ipcMain.handle('palette:openSettings', async () => {
    settingsWindow.open()
  })

  // Fire-and-forget channels for the JS-driven drag on the search input.
  // Using `on` (not `handle`) avoids the IPC round-trip per pointermove.
  ipcMain.on('palette:startMove', () => {
    paletteWindow.startMove()
  })
  ipcMain.on('palette:moveBy', (_e, dx: number, dy: number) => {
    paletteWindow.moveBy(dx, dy)
  })
  ipcMain.on('palette:endMove', () => {
    paletteWindow.endMove()
  })
}

/** Broadcast settings changes to every open renderer. */
export function wireSettingsBroadcast(): void {
  settingsStore.on('change', (settings: Settings) => {
    for (const win of [
      paletteWindow.getBrowserWindow(),
      settingsWindow.getBrowserWindow()
    ]) {
      if (win && !win.isDestroyed()) {
        win.webContents.send('settings:changed', settings)
      }
    }
  })
}
