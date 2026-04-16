import { app, Menu, Tray, nativeImage } from 'electron'
import path from 'path'
import { paletteWindow } from './palette-window'
import { settingsWindow } from './settings-window'

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

    const contextMenu = Menu.buildFromTemplate([
      { label: 'Show Palette', click: () => paletteWindow.show() },
      { label: 'Settings', click: () => settingsWindow.open() },
      { type: 'separator' },
      { label: 'Quit', click: () => app.quit() }
    ])

    this.tray.setContextMenu(contextMenu)

    // Left-click on tray icon toggles the palette (Windows/Linux convention).
    this.tray.on('click', () => paletteWindow.toggle())
  }
}

export const trayManager = new TrayManager()
