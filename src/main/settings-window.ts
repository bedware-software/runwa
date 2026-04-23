import { app, BrowserWindow, nativeTheme } from 'electron'
import path from 'path'
import { settingsStore } from './settings-store'
import type { Settings, SettingsTabId, Theme } from '@shared/types'

const iconPath = app.isPackaged
  ? path.join(process.resourcesPath, 'icon.png')
  : path.join(app.getAppPath(), 'resources', 'icon.png')

const isMac = process.platform === 'darwin'

/**
 * Hex approximations of the `--color-card` / `--color-foreground` tokens from
 * globals.css. These are what `titleBarOverlay` uses to draw the native
 * min/max/close strip on Windows and Linux — they need to match the toolbar
 * background closely enough that the seam at the overlay edge isn't visible.
 * A 1–2 pixel delta gets absorbed by the `border-b` under the toolbar.
 */
const CHROME_COLORS: Record<'light' | 'dark', { bg: string; fg: string }> = {
  dark: { bg: '#0f0f0f', fg: '#d7d7d7' },
  light: { bg: '#fcfcfc', fg: '#1b1b1b' }
}

function resolveTheme(theme: Theme): 'light' | 'dark' {
  if (theme === 'system') return nativeTheme.shouldUseDarkColors ? 'dark' : 'light'
  return theme
}

class SettingsWindow {
  private window: BrowserWindow | null = null
  private offSettingsChange: (() => void) | null = null

  open(tab?: SettingsTabId): void {
    if (this.window && !this.window.isDestroyed()) {
      this.window.show()
      this.window.focus()
      // Existing window — push the tab over IPC. The renderer's
      // `onOpenSettingsTab` subscription is live by the time we get here
      // (set up on mount, long before any subsequent tray click).
      if (tab) this.sendTab(tab)
      return
    }

    const settings = settingsStore.get()
    const effective = resolveTheme(settings.theme)
    const colors = CHROME_COLORS[effective]

    this.window = new BrowserWindow({
      width: 960,
      height: 640,
      minWidth: 720,
      minHeight: 480,
      show: false,
      icon: iconPath,
      title: 'runwa — Settings',
      backgroundColor: colors.bg,
      titleBarStyle: isMac ? 'hiddenInset' : 'hidden',
      ...(isMac
        ? { trafficLightPosition: { x: 14, y: 14 } }
        : {
            autoHideMenuBar: true,
            titleBarOverlay: {
              color: colors.bg,
              symbolColor: colors.fg,
              height: 46
            }
          }),
      webPreferences: {
        preload: path.join(__dirname, '../preload/index.js'),
        contextIsolation: true,
        sandbox: true,
        nodeIntegration: false
      }
    })

    if (!isMac) {
      this.window.setMenuBarVisibility(false)
    }

    this.window.once('ready-to-show', () => {
      this.window?.show()
    })

    // Keep the overlay colors in sync when the user switches themes while the
    // settings window is open. Windows/Linux only — macOS draws the traffic
    // lights itself and doesn't need re-tinting.
    if (!isMac) {
      const handler = (next: Settings): void => {
        if (!this.window || this.window.isDestroyed()) return
        const nextColors = CHROME_COLORS[resolveTheme(next.theme)]
        this.window.setTitleBarOverlay({
          color: nextColors.bg,
          symbolColor: nextColors.fg,
          height: 48
        })
        this.window.setBackgroundColor(nextColors.bg)
      }
      settingsStore.on('change', handler)
      this.offSettingsChange = () => settingsStore.off('change', handler)
    }

    this.window.on('closed', () => {
      this.offSettingsChange?.()
      this.offSettingsChange = null
      this.window = null
    })

    // Initial tab is baked into the hash fragment so the renderer can read
    // it synchronously during mount. Subsequent open-to-tab requests
    // (while the window stays alive) go over the IPC event instead.
    const hash = tab ? `settings?tab=${encodeURIComponent(tab)}` : 'settings'
    if (process.env.ELECTRON_RENDERER_URL) {
      this.window.loadURL(`${process.env.ELECTRON_RENDERER_URL}#${hash}`)
    } else {
      this.window.loadFile(path.join(__dirname, '../renderer/index.html'), { hash })
    }
  }

  getBrowserWindow(): BrowserWindow | null {
    return this.window && !this.window.isDestroyed() ? this.window : null
  }

  private sendTab(tab: SettingsTabId): void {
    const win = this.getBrowserWindow()
    if (!win) return
    // On a fresh window the renderer's subscription isn't wired up by the
    // time `ready-to-show` fires, so buffer the message until the web
    // contents finish loading. On an already-open window this branch
    // skips straight to send.
    if (win.webContents.isLoading()) {
      win.webContents.once('did-finish-load', () => {
        if (!win.isDestroyed()) win.webContents.send('settings:open-tab', tab)
      })
    } else {
      win.webContents.send('settings:open-tab', tab)
    }
  }
}

export const settingsWindow = new SettingsWindow()
