import { app, Menu, MenuItemConstructorOptions, nativeImage, nativeTheme, Tray } from 'electron'
import path from 'path'
import { paletteWindow } from './palette-window'
import { settingsWindow } from './settings-window'
import { resetCapsLockRemap } from './modules/keyboard-remap/hidutil'
import { getCurrentDesktopNumber } from './modules/window-switcher/native'
import { settingsStore } from './settings-store'
import {
  SHOW_DESKTOP_NUMBER_IN_TRAY_DEFAULT,
  SHOW_DESKTOP_NUMBER_IN_TRAY_KEY
} from './modules/keyboard-remap'

/**
 * System tray icon. On Windows, the icon reflects the current virtual
 * desktop number (1..10, `+` for 11+). Two icon themes — `black-on-white`
 * and `white-on-black` — swap based on the OS light/dark preference so the
 * glyph stays readable against whatever taskbar/menu-bar color is in
 * effect.
 *
 * Detection strategy:
 *  - Desktop: polled every 500ms via the native addon. On Windows the
 *    `winvd` crate returns the real ordinal; on macOS / Linux the native
 *    addon returns 0 (Spaces have no public ordinal API), so the icon
 *    stays on "1" regardless of the current Space. Still useful: users
 *    get the same runwa glyph in the menu bar, and the theme-based
 *    light/dark swap still works.
 *  - Theme: `nativeTheme.shouldUseDarkColors` + its `updated` event.
 *    Reads `AppsUseLightTheme` on Windows and the `AppleInterfaceStyle`
 *    default on macOS.
 */

const DESKTOP_POLL_INTERVAL_MS = 500
const MAX_NUMBERED_DESKTOP = 10 // we ship 1.ico…10.ico, then +.ico

class TrayManager {
  private tray: Tray | null = null
  private pollTimer: NodeJS.Timeout | null = null
  private themeListener: (() => void) | null = null
  private settingsListener: (() => void) | null = null
  private lastDesktop = -1
  private lastDark: boolean | null = null
  private lastShowNumber: boolean | null = null

  init(): void {
    const initialDesktop = this.readDesktopNumber()
    const initialDark = nativeTheme.shouldUseDarkColors
    const initialShowNumber = this.readShowNumberSetting()
    const initialIcon = this.resolveIcon(initialDesktop, initialDark, initialShowNumber)

    this.tray = new Tray(initialIcon)
    this.tray.setToolTip(this.tooltipFor(initialDesktop, initialShowNumber))
    this.refreshMenu()

    // Left-click on tray icon toggles the palette (Windows/Linux convention).
    this.tray.on('click', () => paletteWindow.toggle())

    // Prime state so the first poll tick recognises changes correctly.
    this.lastDesktop = initialDesktop
    this.lastDark = initialDark
    this.lastShowNumber = initialShowNumber

    // Poll for desktop changes. Cheap — one native call per tick. On
    // non-Windows platforms this always reads 0, so the branch never
    // fires, but we keep the timer running so there's a single code path
    // across platforms.
    this.pollTimer = setInterval(() => this.tick(), DESKTOP_POLL_INTERVAL_MS)

    // Theme change fires when the user flips system light/dark mode.
    const themeListener = (): void => this.applyIcon()
    nativeTheme.on('updated', themeListener)
    this.themeListener = (): void => nativeTheme.off('updated', themeListener)

    // React to the keyboard-remap module's "show desktop number" toggle
    // being flipped in settings, so the tray switches between the
    // numbered glyph and the plain runwa mark without needing a restart.
    const settingsListener = (): void => {
      const next = this.readShowNumberSetting()
      if (next !== this.lastShowNumber) {
        this.lastShowNumber = next
        this.applyIcon()
      }
    }
    settingsStore.on('change', settingsListener)
    this.settingsListener = (): void => settingsStore.off('change', settingsListener)
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
    if (this.settingsListener) {
      this.settingsListener()
      this.settingsListener = null
    }
    this.tray?.destroy()
    this.tray = null
  }

  private refreshMenu(): void {
    if (!this.tray) return
    const items: MenuItemConstructorOptions[] = [
      { label: 'Show Palette', click: () => paletteWindow.show() },
      { label: 'Settings', click: () => settingsWindow.open() }
    ]

    // macOS-only recovery item: if runwa crashed with the keyboard-remap's
    // hidutil CapsLock→F19 mapping still active, the user is stuck with a
    // broken CapsLock key until reboot. This clears it without a terminal.
    // Hidden on Windows/Linux where no such state exists.
    if (process.platform === 'darwin') {
      items.push(
        { type: 'separator' },
        {
          label: 'Reset CapsLock HID remap',
          toolTip:
            'Clear hidutil UserKeyMapping. Use only after a runwa crash if CapsLock is stuck producing the wrong key.',
          click: () => resetCapsLockRemap()
        }
      )
    }

    items.push({ type: 'separator' }, { label: 'Quit', click: () => app.quit() })

    this.tray.setContextMenu(Menu.buildFromTemplate(items))
  }

  private tick(): void {
    const desktop = this.readDesktopNumber()
    if (desktop !== this.lastDesktop) {
      this.lastDesktop = desktop
      this.applyIcon()
    }
  }

  /**
   * Render whatever icon the current (desktop, theme, show-number) tuple
   * resolves to, plus the matching tooltip. Cheap — called on each poll
   * tick that detects a change, on theme updates, and on the module's
   * settings toggle.
   */
  private applyIcon(): void {
    if (!this.tray) return
    const dark = nativeTheme.shouldUseDarkColors
    this.lastDark = dark
    const showNumber = this.lastShowNumber ?? SHOW_DESKTOP_NUMBER_IN_TRAY_DEFAULT
    const icon = this.resolveIcon(this.lastDesktop, dark, showNumber)
    this.tray.setImage(icon)
    this.tray.setToolTip(this.tooltipFor(this.lastDesktop, showNumber))
  }

  /**
   * Pick an icon based on whether the user wants the numbered desktop
   * glyph or the plain runwa mark. The numbered path still honours the
   * light/dark theme swap — the fallback just returns the static PNG.
   */
  private resolveIcon(
    zeroBasedDesktop: number,
    dark: boolean,
    showNumber: boolean
  ): Electron.NativeImage {
    if (!showNumber) return this.fallbackIcon()
    return this.iconForDesktop(zeroBasedDesktop, dark)
  }

  /**
   * Tooltip text. On Windows we include the current desktop ordinal when
   * the numbered icon is active — on other platforms or when the user
   * disabled the number, we just say "runwa".
   */
  private tooltipFor(zeroBasedDesktop: number, showNumber: boolean): string {
    if (showNumber && process.platform === 'win32') {
      return `runwa — desktop ${zeroBasedDesktop + 1}`
    }
    return 'runwa'
  }

  /**
   * Read the `showDesktopNumberInTray` toggle off the keyboard-remap
   * module's config. Falls back to the manifest default if the setting
   * isn't written yet (fresh install) or has the wrong type (hand-edited
   * JSON).
   */
  private readShowNumberSetting(): boolean {
    const cfg = settingsStore.get().modules['keyboard-remap']?.config
    const v = cfg?.[SHOW_DESKTOP_NUMBER_IN_TRAY_KEY]
    return typeof v === 'boolean' ? v : SHOW_DESKTOP_NUMBER_IN_TRAY_DEFAULT
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
    // Windows reads .ico natively (multi-resolution). Electron's
    // `nativeImage.createFromPath` on macOS can't decode the 4-bit indexed
    // .ico variants we ship, so we keep PNG copies alongside for every
    // icon and pick the format per-platform. PNG is also a safer bet on
    // Linux.
    const ext = process.platform === 'win32' ? 'ico' : 'png'
    const iconPath = path.join(this.iconsRoot(), themeDir, `${fileBase}.${ext}`)
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
