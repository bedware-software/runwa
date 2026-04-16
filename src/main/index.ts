import { app } from 'electron'
import { settingsStore } from './settings-store'
import { moduleRegistry } from './modules/registry'
import { registerModules } from './modules'
import { paletteWindow } from './palette-window'
import { settingsWindow } from './settings-window'
import { hotkeyManager } from './hotkey-manager'
import { registerIpcHandlers, wireSettingsBroadcast } from './ipc/handlers'
import { trayManager } from './tray'

// Single-instance lock — a second `runwa` launch just shows the palette.
const gotLock = app.requestSingleInstanceLock()
if (!gotLock) {
  app.quit()
  process.exit(0)
}

app.on('second-instance', () => {
  paletteWindow.show()
})

app.whenReady().then(async () => {
  // Hide the dock icon on macOS — runwa is a background launcher, not a regular app.
  if (process.platform === 'darwin') {
    app.dock?.hide()
  }

  // 1. Persistence layer
  settingsStore.init()

  // 2. Module registry (cache hydrated from settings internally)
  moduleRegistry.init()

  // 3. Register all modules with the registry
  await registerModules()

  // 4. Create (but don't show) the palette window
  paletteWindow.create()

  // 5. IPC + settings broadcast
  registerIpcHandlers()
  wireSettingsBroadcast()

  // 6. System tray
  trayManager.init()

  // 7. Global shortcuts — must come after settings is ready
  hotkeyManager.init()

  // 8. Fallback: if the activation hotkey couldn't be registered (another
  //    app owns it — PowerToys, AutoHotkey, Windows itself, etc.), open the
  //    settings window so the user can pick a working chord. Without this
  //    it's impossible to reach settings on first launch.
  if (!hotkeyManager.isActivationRegistered()) {
    console.warn(
      '[main] activation hotkey not registered - opening settings so you can rebind it'
    )
    settingsWindow.open()
  }
})

// Background launcher: never quit when all windows close.
app.on('window-all-closed', () => {
  // no-op: keep the app alive so the global hotkey still works
})

app.on('will-quit', () => {
  hotkeyManager.dispose()
})
