import { app, Menu, MenuItemConstructorOptions, Tray, nativeImage } from 'electron'
import path from 'path'
import { paletteWindow } from './palette-window'
import { settingsWindow } from './settings-window'
import { resetCapsLockRemap } from './modules/keyboard-remap/hidutil'

class TrayManager {
  private tray: Tray | null = null

  init(): void {
    const iconPath = app.isPackaged
      ? path.join(process.resourcesPath, 'icon.png')
      : path.join(app.getAppPath(), 'resources', 'icon.png')

    // Resize to 16x16 — the native tray icon size on most platforms.
    const icon = nativeImage.createFromPath(iconPath).resize({ width: 16, height: 16 })

    this.tray = new Tray(icon)
    this.tray.setToolTip('runwa')

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

    // Left-click on tray icon toggles the palette (Windows/Linux convention).
    this.tray.on('click', () => paletteWindow.toggle())
  }
}

export const trayManager = new TrayManager()
