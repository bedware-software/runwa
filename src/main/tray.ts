import { app, Menu, nativeImage, nativeTheme, Tray } from 'electron'
import path from 'path'
import { paletteWindow } from './palette-window'
import { settingsWindow } from './settings-window'
import { getCurrentDesktopNumber } from './modules/window-switcher/native'

/**
 * System tray icon. On Windows, the icon reflects the current virtual
 * desktop number (1..10, `+` for 11+). Two icon themes — `black-on-white`
 * and `white-on-black` — swap based on the OS light/dark preference so the
 * glyph stays readable against whatever taskbar color is in effect.
 *
 * Detection strategy:
 *  - Desktop: polled every 500ms via the native addon (`winvd` crate).
 *    There is a push-style `RegisterPostMessageHook` we could wire in
 *    later, but it needs a native window handle to receive the message
 *    and the polling cost is negligible (single COM call per tick).
 *  - Theme: `nativeTheme.shouldUseDarkColors` + its `updated` event. This
 *    reads the same `AppsUseLightTheme` registry value the AHK version of
 *    the script relied on.
 *
 * On non-Windows platforms the number is meaningless (macOS Spaces don't
 * expose an ordinal; Linux varies by WM) — we fall back to the static
 * `icon.png` used pre-iteration-2.
 */

const DESKTOP_POLL_INTERVAL_MS = 500
const MAX_NUMBERED_DESKTOP = 10 // we ship 1.ico…10.ico, then +.ico

class TrayManager {
  private tray: Tray | null = null
  private pollTimer: NodeJS.Timeout | null = null
  private themeListener: (() => void) | null = null
  private lastDesktop = -1
  private lastDark: boolean | null = null

  init(): void {
    const isWindows = process.platform === 'win32'

    const initialIcon = isWindows
      ? this.iconForDesktop(this.readDesktopNumber(), nativeTheme.shouldUseDarkColors)
      : this.fallbackIcon()

    this.tray = new Tray(initialIcon)
    this.tray.setToolTip('runwa')
    this.refreshMenu()

    // Left-click on tray icon toggles the palette (Windows/Linux convention).
    this.tray.on('click', () => paletteWindow.toggle())

    if (isWindows) {
      // Prime state so the first poll tick recognises changes correctly.
      this.lastDesktop = this.readDesktopNumber()
      this.lastDark = nativeTheme.shouldUseDarkColors

      // Poll for desktop changes. Cheap — one native COM call per tick.
      this.pollTimer = setInterval(() => this.tick(), DESKTOP_POLL_INTERVAL_MS)

      // Theme change fires when the user flips Settings → Colors → Mode.
      const listener = (): void => this.onThemeOrDesktopChanged()
      nativeTheme.on('updated', listener)
      this.themeListener = (): void => nativeTheme.off('updated', listener)
    }
  }

  dispose(): void {
    if (this.pollTimer) {
      clearInterval(this.pollTimer)
      this.pollTimer = null
    }
    if (this.themeListener) {
      this.themeListener()
      this.themeListener = null
    }
    this.tray?.destroy()
    this.tray = null
  }

  private refreshMenu(): void {
    if (!this.tray) return
    const contextMenu = Menu.buildFromTemplate([
      { label: 'Show Palette', click: () => paletteWindow.show() },
      { label: 'Settings', click: () => settingsWindow.open() },
      { type: 'separator' },
      { label: 'Quit', click: () => app.quit() }
    ])
    this.tray.setContextMenu(contextMenu)
  }

  private tick(): void {
    const desktop = this.readDesktopNumber()
    if (desktop !== this.lastDesktop) {
      this.lastDesktop = desktop
      this.onThemeOrDesktopChanged()
    }
  }

  private onThemeOrDesktopChanged(): void {
    if (!this.tray) return
    const dark = nativeTheme.shouldUseDarkColors
    this.lastDark = dark
    const icon = this.iconForDesktop(this.lastDesktop, dark)
    this.tray.setImage(icon)
    this.tray.setToolTip(`runwa — desktop ${this.lastDesktop + 1}`)
  }

  private readDesktopNumber(): number {
    try {
      return getCurrentDesktopNumber()
    } catch {
      // Native addon missing / winvd hiccup — fall back to 0 so the tray
      // just shows desktop 1 instead of crashing.
      return 0
    }
  }

  /**
   * Resolve the path to the .ico file for the given desktop index (0-based)
   * and system theme, then hand Electron the NativeImage.
   *
   * Theme mapping is intentionally inverted vs the taskbar — dark taskbar
   * gets `black-on-white` (light tile, dark digit), light taskbar gets
   * `white-on-black`. Gives the glyph a pop-through-background look so the
   * current-desktop indicator reads at a glance. Mirrors the AHK script in
   * the user's .dotfiles.
   */
  private iconForDesktop(zeroBased: number, dark: boolean): Electron.NativeImage {
    const humanNum = zeroBased + 1
    const fileBase = humanNum > MAX_NUMBERED_DESKTOP ? '+' : String(humanNum)
    const themeDir = dark ? 'black-on-white' : 'white-on-black'
    const iconPath = path.join(this.iconsRoot(), themeDir, `${fileBase}.ico`)
    const img = nativeImage.createFromPath(iconPath)
    if (img.isEmpty()) {
      console.warn(`[tray] icon missing at ${iconPath} — falling back to app icon`)
      return this.fallbackIcon()
    }
    return img
  }

  private fallbackIcon(): Electron.NativeImage {
    const p = app.isPackaged
      ? path.join(process.resourcesPath, 'icon.png')
      : path.join(app.getAppPath(), 'resources', 'icon.png')
    return nativeImage.createFromPath(p).resize({ width: 16, height: 16 })
  }

  private iconsRoot(): string {
    // Packaged apps: electron-builder copies `resources/tray-icons` to
    // `process.resourcesPath/tray-icons` (see electron-builder.yml).
    // Dev runs read straight from the repo.
    return app.isPackaged
      ? path.join(process.resourcesPath, 'tray-icons')
      : path.join(app.getAppPath(), 'resources', 'tray-icons')
  }
}

export const trayManager = new TrayManager()
