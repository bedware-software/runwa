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
import { keyboardRemapService } from './modules/keyboard-remap/service'
import { cleanupStaleCapsLockRemap } from './modules/keyboard-remap/hidutil'
import { hotstringService } from './modules/hotstrings/service'
import { HOTSTRINGS_RULES_KEY } from './modules/hotstrings'
import { initAutoUpdater } from './auto-update'
import { forceKillSelf, logProcessSnapshot } from './process-utils'
import { syncStartupIntegrations } from './startup-integration'
import {
  requestScreenRecordingPermission,
  isScreenRecordingGranted,
  requestAccessibilityPermission,
  isAccessibilityTrusted
} from './modules/window-switcher/native'

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
  // Very first thing: what was already alive when we came up? If the
  // previous session's orphan is still there, the startup snapshot
  // catches it.
  logProcessSnapshot('startup')

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

  // 9. Low-level keyboard remap (CapsLock → Ctrl/Esc, Space layer).
  //    Gated by the module's `enabled` flag so users can turn it off
  //    without removing anything. React to toggle changes live — the
  //    settings store emits on every change; start/stop when the flag
  //    transitions so users don't need to restart runwa.
  //    Before anything runs, clean up a stale CapsLock→F19 hidutil mapping
  //    left behind by a prior crashed instance. If the module is still
  //    enabled, the service's install() will re-apply it; if it's been
  //    disabled since the crash, this recovers the user's CapsLock key
  //    without needing a reboot. No-op on non-macOS.
  cleanupStaleCapsLockRemap()
  if (isKeyboardRemapEnabled()) {
    keyboardRemapService.start()
  }
  let keyboardRemapEnabled = isKeyboardRemapEnabled()
  settingsStore.on('change', () => {
    const next = isKeyboardRemapEnabled()
    if (next === keyboardRemapEnabled) return
    keyboardRemapEnabled = next
    if (next) {
      keyboardRemapService.start()
    } else {
      keyboardRemapService.stop()
    }
  })

  // 9a. Hotstrings — global snippet expander. Reads its rules list from
  //     the module config and refreshes it on every settings change, so
  //     editing the textarea in the settings panel takes effect live.
  const initialHot = readHotstringsConfig()
  if (initialHot.enabled) {
    hotstringService.start(initialHot.rules)
  }
  let lastHotEnabled = initialHot.enabled
  let lastHotRules = initialHot.rules
  settingsStore.on('change', () => {
    const next = readHotstringsConfig()
    if (next.enabled === lastHotEnabled && next.rules === lastHotRules) return
    lastHotEnabled = next.enabled
    lastHotRules = next.rules
    hotstringService.reconfigure(next.rules, next.enabled)
  })

  // 10. Auto-update. Kicks off a background check against the GitHub
  //     Releases publish target configured in electron-builder.yml and
  //     schedules periodic re-checks. No-op in unpackaged dev runs.
  initAutoUpdater()

  // 10a. Apply the "Start at login" / "Run as administrator" toggles
  //      from settings to the OS (registry / login items). Also
  //      re-apply on every settings change so flipping a toggle in
  //      the panel takes effect immediately without restart.
  const current = settingsStore.get()
  syncStartupIntegrations({
    startAtLogin: current.startAtLogin,
    runAsAdmin: current.runAsAdmin
  })
  settingsStore.on('change', (s) =>
    syncStartupIntegrations({
      startAtLogin: s.startAtLogin,
      runAsAdmin: s.runAsAdmin
    })
  )

  // 11. Fallback: if the activation hotkey couldn't be registered (another
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
  // Trace each dispose step — if the process hangs during will-quit,
  // the last line printed to the electron-vite terminal tells us
  // which dispose is stuck. Without this, the hang is invisible.
  console.log('[shutdown] will-quit: start')
  try {
    console.log('[shutdown] hotkeyManager.dispose…')
    hotkeyManager.dispose()
    console.log('[shutdown] hotkeyManager.dispose OK')
  } catch (err) {
    console.warn('[shutdown] hotkeyManager.dispose threw:', err)
  }
  try {
    console.log('[shutdown] recorderWindow.dispose…')
    recorderWindow.dispose()
    console.log('[shutdown] recorderWindow.dispose OK')
  } catch (err) {
    console.warn('[shutdown] recorderWindow.dispose threw:', err)
  }
  try {
    console.log('[shutdown] indicatorWindow.dispose…')
    indicatorWindow.dispose()
    console.log('[shutdown] indicatorWindow.dispose OK')
  } catch (err) {
    console.warn('[shutdown] indicatorWindow.dispose threw:', err)
  }
  try {
    console.log('[shutdown] keyboardRemapService.stop…')
    keyboardRemapService.stop()
    console.log('[shutdown] keyboardRemapService.stop OK')
  } catch (err) {
    console.warn('[shutdown] keyboardRemapService.stop threw:', err)
  }
  try {
    console.log('[shutdown] hotstringService.stop…')
    hotstringService.stop()
    console.log('[shutdown] hotstringService.stop OK')
  } catch (err) {
    console.warn('[shutdown] hotstringService.stop threw:', err)
  }
  // Exit via external `taskkill /F /PID self` rather than Node's
  // `process.exit(0)`. Why: when Electron's stdio is piped to a Node
  // parent (exactly what electron-vite does in dev, exactly what
  // electron-updater's installer spawn does after quit), Electron
  // 9+ hangs on shutdown for ~15 s while Chromium's DLL teardown
  // runs — see electron/electron#27084. `process.exit` goes through
  // `ExitProcess`, which runs `DLL_PROCESS_DETACH` and inherits the
  // same hang. `taskkill /F` sends `TerminateProcess` from a separate
  // process and the kernel kills us instantly, no DLL teardown.
  //
  // spawnSync never returns here — we're dead by the time taskkill
  // has issued TerminateProcess. The unreachable process.exit below
  // is a macOS / Linux fallback (forceKillSelf is a no-op there).
  console.log('[shutdown] will-quit: handler returning — taskkill /F /PID self')
  forceKillSelf()
  process.exit(0)
})

function isKeyboardRemapEnabled(): boolean {
  const s = settingsStore.get()
  const mod = s.modules['keyboard-remap']
  // Fall back to enabled=true when the settings entry doesn't exist yet —
  // registry.register seeds it, but reading from this scope happens after
  // registerModules() so the entry should always be there. The `?? true`
  // handles the degenerate case without blocking the feature.
  return mod?.enabled ?? true
}

/**
 * Pull the hotstrings module's enabled flag + rules text out of settings.
 * Defaults to `{ enabled: false, rules: '' }` on a fresh install — the
 * module is opt-in to avoid a global keystroke hook running unannounced.
 */
function readHotstringsConfig(): { enabled: boolean; rules: string } {
  const s = settingsStore.get()
  const mod = s.modules['hotstrings']
  const rawRules = mod?.config?.[HOTSTRINGS_RULES_KEY]
  return {
    enabled: mod?.enabled ?? false,
    rules: typeof rawRules === 'string' ? rawRules : ''
  }
}
