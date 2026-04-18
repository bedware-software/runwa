import { BrowserWindow, ipcMain, screen } from 'electron'
import path from 'path'

/**
 * Small always-on-top "you're recording" pill that lives at the bottom
 * of the active display while the Groq module is capturing or
 * transcribing. Doesn't steal focus (otherwise the user's current app
 * would lose keyboard focus mid-sentence), is click-through by default,
 * and auto-centers on whichever display currently hosts the cursor.
 *
 * Loaded as the hash-routed `#indicator` view of the main renderer
 * bundle — no separate HTML entry point.
 */

export type IndicatorState = 'hidden' | 'recording' | 'transcribing'

const WIDTH = 180
const HEIGHT = 44
const BOTTOM_MARGIN = 56

class IndicatorWindow {
  private window: BrowserWindow | null = null
  private ready = false
  private pendingState: IndicatorState = 'hidden'
  private currentState: IndicatorState = 'hidden'
  private ipcWired = false

  init(): void {
    if (this.window && !this.window.isDestroyed()) return
    this.wireIpc()

    this.window = new BrowserWindow({
      width: WIDTH,
      height: HEIGHT,
      show: false,
      frame: false,
      skipTaskbar: true,
      resizable: false,
      movable: false,
      minimizable: false,
      maximizable: false,
      // Critical: the indicator must NEVER take focus. Otherwise the user's
      // current app loses keyboard focus while they're mid-sentence, and
      // typed characters (or the release of a modifier held for the hotkey)
      // land in the wrong place.
      focusable: false,
      hasShadow: false,
      transparent: true,
      alwaysOnTop: true,
      backgroundColor: '#00000000',
      webPreferences: {
        preload: path.join(__dirname, '../preload/index.js'),
        contextIsolation: true,
        sandbox: true,
        nodeIntegration: false
      }
    })

    // Pin above fullscreen apps and float on every Space on macOS, matching
    // the palette's behavior — the indicator should be visible whichever
    // Space the user is on when they trigger the hotkey.
    this.window.setAlwaysOnTop(true, 'screen-saver')
    if (process.platform === 'darwin') {
      this.window.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true })
    }
    // Click-through: the user can interact with whatever's underneath
    // (their editor, terminal, etc.) without the indicator eating clicks.
    this.window.setIgnoreMouseEvents(true, { forward: true })

    this.window.on('closed', () => {
      this.window = null
      this.ready = false
      this.currentState = 'hidden'
    })

    if (process.env.ELECTRON_RENDERER_URL) {
      this.window.loadURL(process.env.ELECTRON_RENDERER_URL + '#indicator')
    } else {
      this.window.loadFile(path.join(__dirname, '../renderer/index.html'), {
        hash: 'indicator'
      })
    }
  }

  private wireIpc(): void {
    if (this.ipcWired) return
    this.ipcWired = true
    ipcMain.on('groq-stt:indicator:ready', (e) => {
      if (!this.window || e.sender.id !== this.window.webContents.id) return
      this.ready = true
      // If main asked for a state while the renderer was still booting,
      // deliver it now.
      if (this.pendingState !== this.currentState) {
        this.applyState(this.pendingState)
      }
    })
  }

  setState(state: IndicatorState): void {
    this.pendingState = state
    this.init()
    if (this.ready) {
      this.applyState(state)
    }
  }

  private applyState(state: IndicatorState): void {
    if (!this.window || this.window.isDestroyed()) return
    const win = this.window
    this.currentState = state
    win.webContents.send('groq-stt:indicator:state', state)

    if (state === 'hidden') {
      if (win.isVisible()) win.hide()
      return
    }

    // Recenter on the display with the cursor so the pill shows up where
    // the user is looking right now (multi-monitor setups otherwise tend
    // to park it on the primary display regardless of context).
    const cursor = screen.getCursorScreenPoint()
    const display = screen.getDisplayNearestPoint(cursor)
    const { x: dx, y: dy, width: dw, height: dh } = display.workArea
    const x = Math.round(dx + (dw - WIDTH) / 2)
    const y = Math.round(dy + dh - HEIGHT - BOTTOM_MARGIN)
    win.setBounds({ x, y, width: WIDTH, height: HEIGHT })

    if (!win.isVisible()) {
      // showInactive avoids stealing focus from the user's active app —
      // even with focusable:false, a plain show() briefly grabs focus on
      // Windows before relinquishing it.
      win.showInactive()
    }
  }

  dispose(): void {
    if (this.window && !this.window.isDestroyed()) {
      this.window.destroy()
    }
    this.window = null
    this.ready = false
    this.currentState = 'hidden'
    this.pendingState = 'hidden'
  }
}

export const indicatorWindow = new IndicatorWindow()
