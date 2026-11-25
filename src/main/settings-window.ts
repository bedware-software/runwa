import { app, BrowserWindow, nativeTheme } from 'electron'
import path from 'path'
import { settingsStore } from './settings-store'
import {
  DEFAULT_SETTINGS,
  type LightBackground,
  type Settings,
  type SettingsTabId,
  type Theme
} from '@shared/types'

const iconPath = app.isPackaged
  ? path.join(process.resourcesPath, 'icon.png')
  : path.join(app.getAppPath(), 'resources', 'icon.png')

const isMac = process.platform === 'darwin'

/**
 * The `--color-card` / `--color-foreground` values of the bedware design
 * system (`surface-1` / `text` in @bedware/ui's tailwind-theme.css) — update
 * by hand when those tokens change. These are what `titleBarOverlay` uses to draw the native
 * min/max/close strip on Windows and Linux — they need to match the toolbar
 * background closely enough that the seam at the overlay edge isn't visible.
 * A 1–2 pixel delta gets absorbed by the `border-b` under the toolbar.
 */
const DARK_CHROME = { bg: '#0e0d0c', fg: '#f4f1e8' }
/** One per light background (the design system's light theme and its steps). */
const LIGHT_CHROME: Record<LightBackground, { bg: string; fg: string }> = {
  white: { bg: '#f5f5f3', fg: '#1a1a18' },
  paper: { bg: '#faf8f2', fg: '#1d1b18' },
  soft: { bg: '#f4f1e8', fg: '#1a1a18' },
  steel: { bg: '#edf0f4', fg: '#171a1f' },
  stone: { bg: '#cfd1d4', fg: '#111111' }
}

function chromeColors(settings: Settings): { bg: string; fg: string } {
  const dark =
    settings.theme === 'system' ? nativeTheme.shouldUseDarkColors : settings.theme === 'dark'
  if (dark) return DARK_CHROME
  return (
    LIGHT_CHROME[settings.lightBackground ?? DEFAULT_SETTINGS.lightBackground] ??
    LIGHT_CHROME.white
  )
}

class SettingsWindow {
  private window: BrowserWindow | null = null
  private offSettingsChange: (() => void) | null = null
  private offNativeThemeChange: (() => void) | null = null

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
    const colors = chromeColors(settings)

    this.window = new BrowserWindow({
      width: 960,
      height: 640,
      minWidth: 720,
      minHeight: 480,
      show: false,
      icon: iconPath,
      title: `${app.getName()} — Settings`,
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
      const applyChromeTheme = (next: Settings): void => {
        if (!this.window || this.window.isDestroyed()) return
        const nextColors = chromeColors(next)
        this.window.setTitleBarOverlay({
          color: nextColors.bg,
          symbolColor: nextColors.fg,
          height: 48
        })
        this.window.setBackgroundColor(nextColors.bg)
      }
      const handler = (next: Settings): void => {
        applyChromeTheme(next)
      }
      const nativeThemeHandler = (): void => {
        // When Runwa follows System, Auto Dark Mode changes the OS without
        // mutating Settings.theme. Listen to nativeTheme as well so the
        // Windows title-bar overlay follows that live appearance change.
        applyChromeTheme(settingsStore.get())
      }
      settingsStore.on('change', handler)
      nativeTheme.on('updated', nativeThemeHandler)
      this.offSettingsChange = () => settingsStore.off('change', handler)
      this.offNativeThemeChange = () =>
        nativeTheme.off('updated', nativeThemeHandler)
    }

    this.window.on('closed', () => {
      this.offSettingsChange?.()
      this.offSettingsChange = null
      this.offNativeThemeChange?.()
      this.offNativeThemeChange = null
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
