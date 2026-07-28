import { BrowserWindow, ipcMain, screen } from 'electron'
import path from 'path'
import type { DesktopHintPayload } from '@shared/types'

/**
 * Shared, focusless desktop overlay for short status and mode-change hints.
 *
 * The renderer owns the Fluent-inspired surface; this class owns window
 * lifetime, display placement, source-aware dismissal, and optional
 * auto-hide. It intentionally lives outside any feature module so Groq,
 * Hotstrings, Auto Dark Mode, and future services can share one visual
 * language without depending on each other.
 */

// Transparent breathing room keeps the CSS shadow from being clipped by the
// frameless BrowserWindow while the visible surface retains its compact size.
const WIDTH = 360
const HEIGHT = 104
const BOTTOM_MARGIN = 32

interface DesktopHintEntry {
  payload: DesktopHintPayload
  hideTimer: NodeJS.Timeout | null
}

class DesktopHintWindow {
  private window: BrowserWindow | null = null
  private ready = false
  /**
   * In insertion order, oldest to newest. A new `show` moves its source to
   * the top. Hidden entries keep their own lifetime so a short-lived hint
   * cannot permanently erase an ongoing status owned by another module.
   */
  private entries = new Map<string, DesktopHintEntry>()
  private currentSource: string | null = null
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
      // A hint must never interrupt typing or release focus from the app the
      // user is working in.
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

    this.window.setAlwaysOnTop(true, 'screen-saver')
    if (process.platform === 'darwin') {
      this.window.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true })
    }
    // The transparent margins around the surface should not create a dead
    // patch over the user's current app.
    this.window.setIgnoreMouseEvents(true, { forward: true })

    this.window.on('closed', () => {
      this.window = null
      this.ready = false
      this.currentSource = null
    })

    if (process.env.ELECTRON_RENDERER_URL) {
      this.window.loadURL(
        `${process.env.ELECTRON_RENDERER_URL}#desktop-hint`
      )
    } else {
      this.window.loadFile(path.join(__dirname, '../renderer/index.html'), {
        hash: 'desktop-hint'
      })
    }
  }

  getBrowserWindow(): BrowserWindow | null {
    return this.window && !this.window.isDestroyed() ? this.window : null
  }

  /**
   * Show or replace a source-owned hint and move it to the top. A positive
   * duration starts once the renderer is ready, so a cold renderer never
   * consumes the hint's lifetime while it is still booting.
   */
  show(payload: DesktopHintPayload): void {
    const normalized = normalizePayload(payload)
    const previous = this.entries.get(normalized.source)
    if (previous?.hideTimer) clearTimeout(previous.hideTimer)

    // Deleting before setting moves an existing source to the end of the Map,
    // making it the newest (visible) entry without a separate ordering list.
    this.entries.delete(normalized.source)
    const entry: DesktopHintEntry = {
      payload: normalized,
      hideTimer: null
    }
    this.entries.set(normalized.source, entry)

    this.init()
    if (this.ready) {
      this.startHideTimer(entry)
      this.applyPayload(normalized)
    }
  }

  /**
   * Remove one source-owned hint. If it was visible, restore the newest
   * remaining entry; late cleanup from Groq therefore cannot hide a newer
   * Hotstrings or Auto Dark Mode hint. Omitting `source` clears every entry.
   */
  hide(source?: string): void {
    if (source === undefined) {
      for (const entry of this.entries.values()) {
        if (entry.hideTimer) clearTimeout(entry.hideTimer)
      }
      this.entries.clear()
      this.currentSource = null
      this.hideWindow()
      return
    }

    const entry = this.entries.get(source)
    if (!entry) return
    if (entry.hideTimer) clearTimeout(entry.hideTimer)
    this.entries.delete(source)

    if (this.currentSource === source) {
      this.currentSource = null
      this.showNewestOrHide()
    }
  }

  dispose(): void {
    for (const entry of this.entries.values()) {
      if (entry.hideTimer) clearTimeout(entry.hideTimer)
    }
    this.entries.clear()
    if (this.window && !this.window.isDestroyed()) {
      this.window.destroy()
    }
    this.window = null
    this.ready = false
    this.currentSource = null
  }

  private wireIpc(): void {
    if (this.ipcWired) return
    this.ipcWired = true

    ipcMain.on('desktop-hint:ready', (event) => {
      const win = this.getBrowserWindow()
      if (!win || event.sender.id !== win.webContents.id) return
      this.ready = true
      // Multiple modules can publish during a cold renderer boot. Start all
      // queued transient lifetimes together now; only the newest entry is
      // drawn, and older persistent entries remain available for restoration.
      for (const entry of this.entries.values()) {
        this.startHideTimer(entry)
      }
      this.showNewestOrHide()
    })
  }

  private applyPayload(payload: DesktopHintPayload): void {
    const win = this.getBrowserWindow()
    if (!win) return

    this.currentSource = payload.source
    win.webContents.send('desktop-hint:payload', payload)

    // Follow the pointer to the display the user is actively looking at.
    const cursor = screen.getCursorScreenPoint()
    const display = screen.getDisplayNearestPoint(cursor)
    const { x: displayX, y: displayY, width, height } = display.workArea
    const x = Math.round(displayX + (width - WIDTH) / 2)
    const y = Math.round(displayY + height - HEIGHT - BOTTOM_MARGIN)
    win.setBounds({ x, y, width: WIDTH, height: HEIGHT })

    if (!win.isVisible()) {
      // Even with focusable:false, showInactive avoids a brief focus flash on
      // Windows that a plain show() can produce.
      win.showInactive()
    }
  }

  private startHideTimer(entry: DesktopHintEntry): void {
    if (entry.hideTimer || entry.payload.durationMs === undefined) return
    entry.hideTimer = setTimeout(() => {
      entry.hideTimer = null
      // A source may have published a replacement since this timer was
      // created. Only expire the exact entry that owns this callback.
      if (this.entries.get(entry.payload.source) !== entry) return
      this.entries.delete(entry.payload.source)
      if (this.currentSource === entry.payload.source) {
        this.currentSource = null
        this.showNewestOrHide()
      }
    }, entry.payload.durationMs)
    entry.hideTimer.unref()
  }

  private showNewestOrHide(): void {
    if (!this.ready) return

    let newest: DesktopHintEntry | null = null
    for (const entry of this.entries.values()) newest = entry
    if (newest) {
      this.applyPayload(newest.payload)
    } else {
      this.hideWindow()
    }
  }

  private hideWindow(): void {
    const win = this.getBrowserWindow()
    if (!win) return
    if (this.ready) {
      win.webContents.send('desktop-hint:payload', null)
    }
    if (win.isVisible()) win.hide()
  }
}

function normalizePayload(payload: DesktopHintPayload): DesktopHintPayload {
  const source = payload.source.trim()
  const message = payload.message.trim()
  if (!source) throw new Error('Desktop Hint source must not be empty.')
  if (!message) throw new Error('Desktop Hint message must not be empty.')

  const durationMs =
    typeof payload.durationMs === 'number' &&
    Number.isFinite(payload.durationMs) &&
    payload.durationMs > 0
      ? Math.max(250, Math.round(payload.durationMs))
      : undefined

  return {
    source,
    message,
    ...(payload.icon ? { icon: payload.icon } : {}),
    ...(durationMs !== undefined ? { durationMs } : {})
  }
}

export const desktopHintWindow = new DesktopHintWindow()
