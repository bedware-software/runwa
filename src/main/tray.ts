import { app, Menu, MenuItemConstructorOptions, nativeImage, Tray } from 'electron'
import { readFileSync } from 'fs'
import path from 'path'
import { settingsWindow } from './settings-window'
import { resetCapsLockRemap } from './modules/keyboard-remap/hidutil'
import { checkForUpdatesNow } from './auto-update'
import { getCurrentDesktopNumber } from './modules/window-switcher/native'
import { settingsStore } from './settings-store'
import {
  SHOW_DESKTOP_NUMBER_IN_TRAY_DEFAULT,
  SHOW_DESKTOP_NUMBER_IN_TRAY_KEY
} from './modules/keyboard-remap'

/**
 * System tray icon. On Windows, the icon reflects the current virtual
 * desktop number (1..10, `+` for 11+). A single `black-on-white` icon set
 * is used regardless of the OS light/dark preference.
 *
 * Desktop detection: polled every 500ms via the native addon. On Windows
 * the `winvd` crate returns the real ordinal; on macOS / Linux the native
 * addon returns 0 (Spaces have no public ordinal API), so the icon stays
 * on "1" regardless of the current Space.
 */

const DESKTOP_POLL_INTERVAL_MS = 500
const MAX_NUMBERED_DESKTOP = 10 // we ship 1.ico…10.ico, then +.ico

class TrayManager {
  private tray: Tray | null = null
  private pollTimer: NodeJS.Timeout | null = null
  private settingsListener: (() => void) | null = null
  private lastDesktop = -1
  private lastShowNumber: boolean | null = null

  init(): void {
    const initialDesktop = this.readDesktopNumber()
    const initialShowNumber = this.readShowNumberSetting()
    const initialIcon = this.resolveIcon(initialDesktop, initialShowNumber)

    this.tray = new Tray(initialIcon)
    this.tray.setToolTip(this.tooltipFor(initialDesktop, initialShowNumber))
    this.refreshMenu()

    // Prime state so the first poll tick recognises changes correctly.
    this.lastDesktop = initialDesktop
    this.lastShowNumber = initialShowNumber

    // Poll for desktop changes. Cheap — one native call per tick. On
    // non-Windows platforms this always reads 0, so the branch never
    // fires, but we keep the timer running so there's a single code path
    // across platforms.
    this.pollTimer = setInterval(() => this.tick(), DESKTOP_POLL_INTERVAL_MS)

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

    items.push(
      { type: 'separator' },
      {
        label: 'Check for updates',
        // Route through the About tab so the user sees the live update
        // status (checking → downloading → ready). The check itself is a
        // no-op in unpackaged dev runs; the About panel still surfaces a
        // "disabled for dev builds" state so the click isn't a dead end.
        click: () => {
          settingsWindow.open('about')
          void checkForUpdatesNow()
        }
      },
      {
        label: `About ${app.getName()} ${app.getVersion()}`,
        click: () => settingsWindow.open('about')
      },
      { type: 'separator' },
      { label: 'Quit', click: () => app.quit() }
    )

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
   * Render whatever icon the current (desktop, show-number) tuple
   * resolves to, plus the matching tooltip. Cheap — called on each poll
   * tick that detects a change and on the module's settings toggle.
   */
  private applyIcon(): void {
    if (!this.tray) return
    const showNumber = this.lastShowNumber ?? SHOW_DESKTOP_NUMBER_IN_TRAY_DEFAULT
    const icon = this.resolveIcon(this.lastDesktop, showNumber)
    this.tray.setImage(icon)
    this.tray.setToolTip(this.tooltipFor(this.lastDesktop, showNumber))
  }

  /**
   * Pick an icon based on whether the user wants the numbered desktop
   * glyph or the plain runwa mark.
   */
  private resolveIcon(zeroBasedDesktop: number, showNumber: boolean): Electron.NativeImage {
    if (!showNumber) return this.fallbackIcon()
    return this.iconForDesktop(zeroBasedDesktop)
  }

  /**
   * Tooltip text. On Windows we include the current desktop ordinal when
   * the numbered icon is active — on other platforms or when the user
   * disabled the number, we just show the app name.
   */
  private tooltipFor(zeroBasedDesktop: number, showNumber: boolean): string {
    const name = app.getName()
    if (showNumber && process.platform === 'win32') {
      return `${name} — desktop ${zeroBasedDesktop + 1}`
    }
    return name
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
   * Resolve the path to the .png file for the given desktop index (0-based)
   * and hand Electron the NativeImage.
   */
  private iconForDesktop(zeroBased: number): Electron.NativeImage {
    const humanNum = zeroBased + 1
    const fileBase = humanNum > MAX_NUMBERED_DESKTOP ? '+' : String(humanNum)
    // One 44×44 PNG per number — single source, no Retina sibling file, no
    // Windows-specific .ico. On macOS we read the bytes ourselves and hand
    // them to `createFromBuffer` with width/height 22 and scaleFactor 2 so
    // the 44px image reports itself as a 22pt @2x asset (correct menu-bar
    // size, sharp on Retina). On Windows/Linux `createFromPath` loads the
    // raw 44×44 and the tray shell downscales to fit the notification slot.
    const iconPath = path.join(this.iconsRoot(), 'black-on-white', `${fileBase}.png`)
    const img =
      process.platform === 'darwin'
        ? this.loadAt2x(iconPath)
        : nativeImage.createFromPath(iconPath)
    if (img.isEmpty()) {
      console.warn(`[tray] icon missing at ${iconPath} — falling back to app icon`)
      return this.fallbackIcon()
    }
    return img
  }

  /** macOS helper: load a 44×44 PNG as a 22pt @2x native image. */
  private loadAt2x(iconPath: string): Electron.NativeImage {
    try {
      const buffer = readFileSync(iconPath)
      return nativeImage.createFromBuffer(buffer, {
        width: 22,
        height: 22,
        scaleFactor: 2
      })
    } catch (err) {
      console.warn(`[tray] failed to read ${iconPath}:`, err)
      return nativeImage.createEmpty()
    }
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
