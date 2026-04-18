import { app } from 'electron'
import { settingsStore } from './settings-store'
import { moduleRegistry } from './modules/registry'
import { registerModules } from './modules'
import { paletteWindow } from './palette-window'
import { settingsWindow } from './settings-window'
import { hotkeyManager } from './hotkey-manager'
import { registerIpcHandlers, wireSettingsBroadcast } from './ipc/handlers'
import { trayManager } from './tray'
import { recorderWindow } from './modules/groq-stt/recorder-window'
import { indicatorWindow } from './modules/groq-stt/indicator-window'

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
    // Fire the Screen Recording permission request on every startup. On
    // Sequoia+, TCC refuses to honor a manually-added entry in System
    // Settings unless the process has at least once called
    // `CGRequestScreenCaptureAccess` — without it, `CGPreflightScreenCaptureAccess`
    // returns false forever and `CGWindowList` never surfaces window
    // titles. The call is a no-op after the user has decided once.
    try {
      const {
        requestScreenRecordingPermission,
        isScreenRecordingGranted,
        requestAccessibilityPermission,
        isAccessibilityTrusted
      } = await import('./modules/window-switcher/native')
      // Screen Recording: needed for CGWindowList to return window titles.
      // Accessibility: needed for AX-based precise per-window raise (so
      // clicking Newbro window #3 raises THAT window, not the app's
      // most-recent window). Both requests are no-ops after the user has
      // decided once, but firing them every launch ensures TCC has the
      // app's identifier registered and that a manually-added toggle in
      // System Settings actually binds to us.
      requestScreenRecordingPermission()
      requestAccessibilityPermission()
      console.log(
        `[main] permissions: screen_recording=${isScreenRecordingGranted()} accessibility=${isAccessibilityTrusted()}`
      )
    } catch (err) {
      console.warn('[main] permission request failed', err)
    }
  }

  // 1. Persistence layer
  settingsStore.init()

  // 2. Module registry (cache hydrated from settings internally)
  moduleRegistry.init()

  // 3. Register all modules with the registry
  await registerModules()

  // 4. Create (but don't show) the palette window
  paletteWindow.create()

  // 5. Hidden recorder window — boots the MediaRecorder / getUserMedia
  //    stack in the background so the first press of the Groq hotkey isn't
  //    gated on a cold renderer init. No-op if the groq-stt module is
  //    disabled — the window is cheap (1×1, never shown) and the mic only
  //    opens on demand.
  recorderWindow.init()
  // Pre-create the recording-indicator window (hidden until needed) so the
  // first hotkey press doesn't have to wait for a renderer cold-boot
  // before the user sees the "Listening…" pill.
  indicatorWindow.init()

  // 6. IPC + settings broadcast
  registerIpcHandlers()
  wireSettingsBroadcast()

  // 7. System tray
  trayManager.init()

  // 8. Global shortcuts — must come after settings is ready
  hotkeyManager.init()

  // 9. Fallback: if the activation hotkey couldn't be registered (another
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
  recorderWindow.dispose()
  indicatorWindow.dispose()
})
