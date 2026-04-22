import { app, BrowserWindow, ipcMain, session, shell } from 'electron'
import { spawn } from 'node:child_process'
import { writeFileSync } from 'node:fs'
import path from 'node:path'
import type {
  SearchRequest,
  PaletteItem,
  Settings,
  ModuleId,
  ModuleSettings,
  ModuleConfigValue,
  PermissionName,
  PermissionStatus
} from '@shared/types'
import { settingsStore } from '../settings-store'
import { moduleRegistry } from '../modules/registry'
import { paletteWindow } from '../palette-window'
import { settingsWindow } from '../settings-window'
import { keyboardRemapService } from '../modules/keyboard-remap/service'
import { checkForUpdatesNow, getUpdateStatus } from '../auto-update'
import {
  isAccessibilityTrusted,
  isScreenRecordingGranted,
  requestAccessibilityPermission,
  requestScreenRecordingPermission
} from '../modules/window-switcher/native'

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

  ipcMain.handle('modules:action', async (_e, moduleId: ModuleId, key: string) =>
    moduleRegistry.action(moduleId, key)
  )

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

  ipcMain.handle(
    'settings:setModuleAlias',
    async (_e, moduleId: ModuleId, itemId: string, alias: string | null) =>
      settingsStore.patchModuleAlias(moduleId, itemId, alias)
  )

  // Palette / settings window control
  ipcMain.handle('palette:hide', async () => {
    paletteWindow.hide(true)
  })

  ipcMain.handle('palette:openSettings', async () => {
    settingsWindow.open()
  })

  // Context-menu helper: reveal an absolute path in the system file
  // manager. `shell.showItemInFolder` is effectively a no-op when the
  // path doesn't exist or isn't absolute, so we don't have to validate
  // defensively — a broken path just fails silently on the user's side.
  ipcMain.handle('app:reveal-in-folder', async (_e, p: string) => {
    if (typeof p === 'string' && p.length > 0) {
      shell.showItemInFolder(p)
    }
  })

  // Auto-update: trigger a manual check (button in Settings / tray) and
  // expose the current status for renderers coming up mid-flight (e.g.
  // user opens Settings while a background download is already running).
  ipcMain.handle('app:checkForUpdates', async () => {
    await checkForUpdatesNow()
  })
  ipcMain.handle('app:getUpdateStatus', async () => getUpdateStatus())

  // Keyboard remap — read-only view + reload for the settings panel.
  ipcMain.handle('keyboard-remap:getRules', async () =>
    keyboardRemapService.getRulesView()
  )
  ipcMain.handle('keyboard-remap:reload', async () =>
    keyboardRemapService.reload()
  )

  // macOS permission status surface for the settings UI. Returns null on
  // platforms that don't gate our native calls behind TCC — the renderer
  // uses that to hide the section entirely.
  ipcMain.handle('permissions:get', async (): Promise<PermissionStatus> => {
    if (process.platform !== 'darwin') return null
    return {
      accessibility: isAccessibilityTrusted(),
      screenRecording: isScreenRecordingGranted()
    }
  })

  // Fires the system prompt (no-op if already decided) and returns the
  // current status. The user still has to flip the toggle in System
  // Settings and restart runwa before the AX/CGWindow APIs actually pick
  // up the grant — but the badge updates live off the TCC read.
  ipcMain.handle(
    'permissions:request',
    async (_e, name: PermissionName): Promise<PermissionStatus> => {
      if (process.platform !== 'darwin') return null
      try {
        if (name === 'accessibility') requestAccessibilityPermission()
        else if (name === 'screenRecording') requestScreenRecordingPermission()
      } catch (err) {
        console.warn(`[permissions] request ${name} failed`, err)
      }
      return {
        accessibility: isAccessibilityTrusted(),
        screenRecording: isScreenRecordingGranted()
      }
    }
  )

  // Deep-link into the right System Settings pane. Users who already
  // dismissed the prompt need a path back without digging through menus.
  ipcMain.handle(
    'permissions:openSystemSettings',
    async (_e, name: PermissionName): Promise<void> => {
      if (process.platform !== 'darwin') return
      const anchor =
        name === 'accessibility'
          ? 'Privacy_Accessibility'
          : 'Privacy_ScreenCapture'
      await shell.openExternal(
        `x-apple.systempreferences:com.apple.preference.security?${anchor}`
      )
    }
  )

  // Danger zone — wipe userData and relaunch.
  //
  // We can't delete userData from inside the running process on Windows:
  // Chromium holds file locks on cache / LevelDB until exit. First we
  // clear in-process session data to release most of those locks, then
  // spawn a detached Electron-as-Node helper that waits for our PID to
  // die, rm -rf's userData (with retries), and relaunches a fresh
  // instance. Electron.exe is a GUI subsystem binary, so the helper runs
  // with no console window.
  ipcMain.handle('app:wipe-data', async () => {
    const userDataDir = app.getPath('userData')

    // Best-effort: release Chromium's file locks on userData.
    try {
      const sessions = new Set<Electron.Session>([session.defaultSession])
      for (const win of BrowserWindow.getAllWindows()) {
        try {
          sessions.add(win.webContents.session)
        } catch {
          /* ignore */
        }
      }
      await Promise.all(
        Array.from(sessions).map(async (ses) => {
          try {
            await ses.clearStorageData()
            await ses.clearCache()
            await ses.clearAuthCache()
            await ses.clearHostResolverCache()
          } catch (err) {
            console.warn('wipe-data: failed to clear a session', err)
          }
        })
      )
    } catch (err) {
      console.warn('wipe-data: session clear failed', err)
    }

    try {
      const pid = process.pid
      const scriptPath = path.join(
        app.getPath('temp'),
        `runwa-wipe-${pid}-${Date.now()}.js`
      )
      const relaunchExec = process.execPath
      const relaunchArgs = process.argv.slice(1)
      const relaunchEnv: Record<string, string> = {}
      for (const [key, value] of Object.entries(process.env)) {
        if (key === 'ELECTRON_RUN_AS_NODE') continue
        if (typeof value === 'string') relaunchEnv[key] = value
      }

      // Delete children one-by-one instead of rmSync on the whole tree.
      // If an external process (editor, File Explorer) holds a handle on
      // userData itself, rmSync bails with EBUSY on the top-level rmdir
      // and leaves the contents intact. Per-child deletion still wipes
      // the contents — the empty folder is functionally reset.
      const script = `
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const pid = ${pid};
const target = ${JSON.stringify(userDataDir)};
const relaunchExec = ${JSON.stringify(relaunchExec)};
const relaunchArgs = ${JSON.stringify(relaunchArgs)};
const relaunchEnv = ${JSON.stringify(relaunchEnv)};

function alive(p) {
  try { process.kill(p, 0); return true } catch { return false }
}

async function sleep(ms) { return new Promise(r => setTimeout(r, ms)) }

async function wipeContents(dir) {
  for (let pass = 0; pass < 10; pass++) {
    let entries = [];
    try { entries = fs.readdirSync(dir) } catch { return }
    if (entries.length === 0) return
    for (const name of entries) {
      try {
        fs.rmSync(path.join(dir, name), { recursive: true, force: true, maxRetries: 5, retryDelay: 200 })
      } catch {}
    }
    await sleep(500)
  }
}

(async () => {
  for (let i = 0; i < 150; i++) {
    if (!alive(pid)) break
    await sleep(100)
  }
  await sleep(500)
  if (fs.existsSync(target)) {
    await wipeContents(target)
    try { fs.rmdirSync(target) } catch {}
  }
  try {
    spawn(relaunchExec, relaunchArgs, { detached: true, stdio: 'ignore', env: relaunchEnv }).unref()
  } catch {}
  try { fs.unlinkSync(__filename) } catch {}
})()
`
      writeFileSync(scriptPath, script, 'utf8')
      const helper = spawn(process.execPath, [scriptPath], {
        detached: true,
        stdio: 'ignore',
        env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' }
      })
      helper.unref()
      console.log('[wipe-data] helper spawned, pid=', helper.pid)
    } catch (err) {
      console.error('wipe-data: failed to spawn helper', err)
      return
    }

    for (const win of BrowserWindow.getAllWindows()) {
      try {
        win.removeAllListeners('close')
        win.destroy()
      } catch {
        /* ignore */
      }
    }
    app.exit(0)
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
