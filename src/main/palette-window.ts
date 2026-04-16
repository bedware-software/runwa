import { BrowserWindow, ipcMain, screen } from 'electron'
import path from 'path'
import type { ModuleId, PaletteShowPayload } from '@shared/types'
import { settingsStore } from './settings-store'
import {
  focusWindow as nativeFocus,
  getForegroundWindow
} from './modules/window-switcher/native'

const DEFAULT_WIDTH = 720
const DEFAULT_HEIGHT = 520
const MIN_WIDTH = 480
const MIN_HEIGHT = 320

class PaletteWindow {
  private window: BrowserWindow | null = null
  private resizePersistTimer: NodeJS.Timeout | null = null
  /** Window bounds captured at the start of a JS-driven drag. `moveBy`
   * uses these constant width/height values on every `setBounds` call to
   * work around Electron #9477 — on non-100% DPI scaling, `setPosition`
   * (and even `setBounds` if you re-read width/height via `getSize()`)
   * silently grows the window 1–3 px per call. Capturing ONCE at drag
   * start and never re-reading during the gesture pins the size. */
  /** HWND of the window that was focused before the palette was shown.
   * Used to restore focus when the user dismisses with Escape. */
  private previousWindowId: string | null = null
  private moveStart: {
    x: number
    y: number
    width: number
    height: number
  } | null = null

  create(): void {
    if (this.window && !this.window.isDestroyed()) return

    const saved = settingsStore.get().paletteSize
    const initialWidth = Math.max(saved?.width ?? DEFAULT_WIDTH, MIN_WIDTH)
    const initialHeight = Math.max(saved?.height ?? DEFAULT_HEIGHT, MIN_HEIGHT)

    this.window = new BrowserWindow({
      width: initialWidth,
      height: initialHeight,
      minWidth: MIN_WIDTH,
      minHeight: MIN_HEIGHT,
      show: false,
      frame: false,
      resizable: true,
      movable: true,
      minimizable: false,
      maximizable: false,
      skipTaskbar: true,
      alwaysOnTop: true,
      transparent: false,
      fullscreenable: false,
      backgroundColor: '#00000000',
      webPreferences: {
        preload: path.join(__dirname, '../preload/index.js'),
        contextIsolation: true,
        sandbox: true,
        nodeIntegration: false
      }
    })

    // Persist user-driven resizes so the window remembers its size across
    // invocations. Debounced so we don't thrash disk during a drag.
    this.window.on('resize', () => {
      // Suppress during a JS-driven move: Electron #9477 can fire bogus
      // resize events during our setBounds calls on high-DPI displays,
      // and `getSize()` returns skewed values during the gesture. We must
      // never persist those.
      if (this.moveStart) return
      if (this.resizePersistTimer) clearTimeout(this.resizePersistTimer)
      this.resizePersistTimer = setTimeout(() => {
        this.resizePersistTimer = null
        if (!this.window || this.window.isDestroyed()) return
        if (this.moveStart) return // guard against late-firing timer
        const [width, height] = this.window.getSize()
        // Avoid writing tiny transient sizes during mount / teardown.
        if (width < MIN_WIDTH || height < MIN_HEIGHT) return
        const stored = settingsStore.get().paletteSize
        if (stored?.width === width && stored.height === height) return
        settingsStore.patch({ paletteSize: { width, height } })
      }, 300)
    })

    // Hide when the user clicks away, matching PowerToys default behavior.
    this.window.on('blur', () => this.hide())

    this.window.on('closed', () => {
      if (this.resizePersistTimer) {
        clearTimeout(this.resizePersistTimer)
        this.resizePersistTimer = null
      }
      this.window = null
    })

    // electron-vite sets this env var in dev.
    if (process.env.ELECTRON_RENDERER_URL) {
      this.window.loadURL(process.env.ELECTRON_RENDERER_URL + '#palette')
    } else {
      this.window.loadFile(path.join(__dirname, '../renderer/index.html'), { hash: 'palette' })
    }
  }

  show(moduleId?: ModuleId): void {
    if (!this.window || this.window.isDestroyed()) this.create()
    const win = this.window!

    // Remember which window had focus so we can restore it on dismiss.
    try {
      this.previousWindowId = getForegroundWindow() || null
    } catch {
      this.previousWindowId = null
    }

    // Respect the persisted size if the user has resized before.
    const saved = settingsStore.get().paletteSize
    const width = Math.max(saved?.width ?? DEFAULT_WIDTH, MIN_WIDTH)
    const height = Math.max(saved?.height ?? DEFAULT_HEIGHT, MIN_HEIGHT)

    // Center on the display containing the cursor.
    const cursor = screen.getCursorScreenPoint()
    const display = screen.getDisplayNearestPoint(cursor)
    const { x: dx, y: dy, width: dw, height: dh } = display.workArea
    const x = Math.round(dx + (dw - width) / 2)
    const y = Math.round(dy + dh * 0.28) // upper third, feels natural for launchers
    win.setBounds({ x, y, width, height })

    // Show the window fully transparent so the compositor starts producing
    // fresh frames.  Hidden windows keep a stale compositor cache, causing
    // a one-frame flash of old content when later revealed.  By showing at
    // opacity 0, the window is invisible to the user but the compositor is
    // active and will paint the fresh content produced by the search below.
    win.setOpacity(0)
    win.show()
    win.focus()

    // Tell the renderer to reset & search.
    const payload: PaletteShowPayload = { initialModuleId: moduleId }
    win.webContents.send('palette:show', payload)

    const reveal = (): void => {
      if (win.isDestroyed()) return
      // Guard: if the window was hidden (e.g. blur) during the search,
      // don't re-reveal it.
      if (!win.isVisible()) return
      win.setOpacity(1)
    }

    // Wait for the renderer to signal it has fresh results.
    // Timeout ensures the window still shows if something goes wrong.
    const timeout = setTimeout(reveal, 400)
    ipcMain.once('palette:ready', () => {
      clearTimeout(timeout)
      reveal()
    })
  }

  hide(restoreFocus = false): void {
    if (this.window && !this.window.isDestroyed() && this.window.isVisible()) {
      this.window.hide()
      if (restoreFocus && this.previousWindowId) {
        try {
          nativeFocus(this.previousWindowId)
        } catch {
          // Window may no longer exist — ignore.
        }
      }
    }
    this.previousWindowId = null
  }

  toggle(moduleId?: ModuleId): void {
    if (this.window?.isVisible()) {
      this.hide()
    } else {
      this.show(moduleId)
    }
  }

  getBrowserWindow(): BrowserWindow | null {
    return this.window && !this.window.isDestroyed() ? this.window : null
  }

  // ─── JS-driven drag (from a click on the search input) ──────────────────
  //
  // `-webkit-app-region: drag` can't cover the input because it would block
  // focus + typing. Instead the renderer listens for pointerdown on the
  // input, and once the pointer moves past a threshold it pipes deltas here.

  startMove(): void {
    if (!this.window || this.window.isDestroyed()) return
    const [x, y] = this.window.getPosition()
    const [width, height] = this.window.getSize()
    this.moveStart = { x, y, width, height }
  }

  moveBy(dx: number, dy: number): void {
    if (!this.window || this.window.isDestroyed() || !this.moveStart) return
    const { x, y, width, height } = this.moveStart
    // Electron #9477 workaround: always pass explicit width/height captured
    // at drag start. Using setPosition (or setBounds that re-reads getSize)
    // causes the window to bloat by a pixel or two each call on non-100%
    // DPI. This keeps the size frozen for the entire gesture.
    this.window.setBounds({
      x: Math.round(x + dx),
      y: Math.round(y + dy),
      width,
      height
    })
  }

  endMove(): void {
    this.moveStart = null
  }
}

export const paletteWindow = new PaletteWindow()
