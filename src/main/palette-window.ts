import { BrowserWindow, ipcMain, screen } from 'electron'
import path from 'path'
import type { ModuleId, PaletteShowPayload } from '@shared/types'
import { settingsStore } from './settings-store'
import {
  describeWindow,
  focusTopmostOnCurrentDesktop,
  focusWindow as nativeFocus,
  forceForegroundWindow,
  getForegroundWindow,
  isWindowOnCurrentDesktop
} from './modules/window-switcher/native'

/** HWND of a BrowserWindow as a decimal string, or `null` if the window is
 * gone or the handle can't be decoded (non-Windows platforms, 32-bit Electron,
 * etc.). Decoded from the 8-byte pointer buffer `getNativeWindowHandle`
 * returns on x64 Windows. */
function hwndOf(win: BrowserWindow): string | null {
  if (process.platform !== 'win32' || win.isDestroyed()) return null
  try {
    const handle = win.getNativeWindowHandle()
    return handle.readBigUInt64LE(0).toString()
  } catch {
    return null
  }
}

/** Format an HWND for logs as `id[process.exe: "title"]` so diagnostic output
 * is readable without having to reverse-resolve raw handles. Falls back to
 * the bare id if the native addon can't describe the window (dead handle,
 * non-Windows platform, addon load failure, etc.). */
function fmtHwnd(id: string | null | undefined): string {
  if (!id) return 'none'
  if (process.platform !== 'win32') return id
  try {
    const info = describeWindow(id)
    if (!info) return `${id}[gone]`
    const proc = info.processName || `pid:${info.pid}`
    const title = info.title.length > 60 ? info.title.slice(0, 57) + '...' : info.title
    return title ? `${id}[${proc}: "${title}"]` : `${id}[${proc}]`
  } catch {
    return id
  }
}

const DEFAULT_WIDTH = 720
const DEFAULT_HEIGHT = 520
const MIN_WIDTH = 480
const MIN_HEIGHT = 320

/**
 * Window of time after `show()` during which a blur event is treated as
 * spurious rather than a user dismissal. Needed because:
 *
 *  - AutoHotkey / PowerToys Keyboard Manager and similar remappers commonly
 *    trigger our activation globalShortcut by *injecting* a key chord. Once
 *    the globalShortcut handler fires and we call `forceForegroundWindow`,
 *    the remapper still has to send the injected key-ups. Those key-ups are
 *    routed to whatever was foreground the instant they were generated — if
 *    that's still the previous app (race between our focus grab and the
 *    message pump), that app reclaims focus and the palette blurs within a
 *    frame or two, before the user ever sees it.
 *
 *  - Same class of launchers (Flow Launcher, Wox, PowerToys Run) all ignore
 *    early-blur and re-assert focus. 250 ms covers injected key-up storms
 *    without interfering with legitimate click-away dismissal — a human
 *    can't meaningfully click outside the palette in under ~300 ms.
 */
const BLUR_GRACE_MS = 250

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
  /** Timestamp (ms) of the most recent `show()`. Drives the blur-grace
   * window — see BLUR_GRACE_MS above. */
  private lastShownAt = 0
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

    // macOS Spaces affinity: a BrowserWindow is anchored to the Space where
    // it was created, so calling `show()` from a different Space swaps the
    // user back to the original one (and the window then flickers out as
    // focus is reclaimed by whatever was foreground there). Joining all
    // Spaces makes the window follow the active Space instead, matching
    // Raycast / Alfred / Spotlight behavior. `visibleOnFullScreen` also
    // lets the palette overlay fullscreen apps, which a launcher needs.
    if (process.platform === 'darwin') {
      this.window.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true })
    }

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
    // On virtual-desktop switch the palette blurs but its HWND stays on the
    // originating desktop. Windows doesn't always auto-promote another window
    // on the new desktop (especially with AHK hooks in play), so run the same
    // focus-topmost fallback used on Escape — otherwise the user ends up on
    // Desktop 1 with no active window.
    this.window.on('blur', () => {
      if (!this.window || this.window.isDestroyed()) return
      const ownHwnd = hwndOf(this.window)

      // Early-blur grace: when the activation hotkey was triggered by an
      // injected chord (AutoHotkey `*w::^!s` with Space still physically
      // held, PowerToys Keyboard Manager, etc.), the remapper's pending
      // key-ups arrive after our `forceForegroundWindow` returns, and the
      // previously-foreground app reclaims focus within a couple of frames
      // — usually before the renderer even signals ready. Treat that as
      // spurious: re-grab focus instead of dismissing. 250 ms is too fast
      // for a human click-away to conflict with it.
      if (process.platform === 'win32' && ownHwnd) {
        const sinceShow = Date.now() - this.lastShownAt
        if (sinceShow < BLUR_GRACE_MS) {
          try {
            const ok = forceForegroundWindow(ownHwnd)
            this.window.focus()
            console.log(
              `[palette] blur ignored: ${sinceShow}ms since show, re-focus ok=${ok}`
            )
          } catch (err) {
            console.warn('[palette] blur re-focus failed', err)
          }
          return
        }
      }

      if (process.platform === 'win32' && ownHwnd) {
        try {
          const onCurrent = isWindowOnCurrentDesktop(ownHwnd)
          console.log(`[palette] blur: ownHwnd=${fmtHwnd(ownHwnd)} onCurrentDesktop=${onCurrent}`)
          if (!onCurrent) {
            const result = focusTopmostOnCurrentDesktop(ownHwnd)
            console.log(
              `[palette] blur focus_topmost: ok=${result.ok} picked=${fmtHwnd(result.pickedHwnd)}`
            )
            for (const line of result.log) {
              console.log(`[palette] focus_topmost: ${line}`)
            }
          }
        } catch (err) {
          console.warn('[palette] blur focus_topmost failed', err)
        }
      }
      this.hide()
    })

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
    // Windows virtual-desktop affinity: a BrowserWindow's HWND sticks to the
    // virtual desktop where it was last shown. Hide → switch desktop → show
    // re-reveals the HWND on the *original* desktop, invisibly to the user
    // on the new one. There's no public API to move the HWND, so destroy
    // and rebuild the window on desktops we haven't opened on yet. The
    // renderer is cheap to boot (plain Vite bundle, no async init).
    if (
      this.window &&
      !this.window.isDestroyed() &&
      process.platform === 'win32'
    ) {
      const hwnd = hwndOf(this.window)
      const onCurrent = hwnd ? isWindowOnCurrentDesktop(hwnd) : null
      console.log(
        `[palette] show: existing hwnd=${fmtHwnd(hwnd)} onCurrentDesktop=${onCurrent}`
      )
      if (hwnd && !onCurrent) {
        console.log(`[palette] show: destroying palette stuck on other desktop`)
        this.window.destroy()
        this.window = null
      }
    } else {
      console.log(`[palette] show: no existing window (will create)`)
    }

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
    //
    // Record the show timestamp *before* the call so the blur-grace window
    // covers any early-blur fired during this same tick (e.g. focus grab
    // triggered a blur on ourselves, or an injected-hotkey remapper racing
    // our foreground change).
    this.lastShownAt = Date.now()
    win.setOpacity(0)
    win.show()
    win.focus()

    // Windows foreground-lock: plain SetForegroundWindow from a background
    // process is routinely refused, which leaves the palette on-screen but
    // the *previous* app still owning keyboard focus (and any modifier keys
    // held during the activation hotkey). Next keystroke then fires a
    // shortcut on that app — e.g. Alt is still down from Super+Alt+Space so
    // pressing Space in the palette opens the IDE's system menu.
    //
    // Force the Z-order + input ownership via the AttachThreadInput trick
    // in the native addon. No-op on macOS (Cocoa doesn't gate focus).
    if (process.platform === 'win32') {
      const hwnd = hwndOf(win)
      console.log(
        `[palette] show: post-show hwnd=${fmtHwnd(hwnd)} previousWindowId=${fmtHwnd(this.previousWindowId)}`
      )
      if (hwnd) {
        try {
          const ok = forceForegroundWindow(hwnd)
          console.log(`[palette] show: forceForeground result=${ok}`)
        } catch (err) {
          console.warn('[palette] forceForeground failed', err)
        }
      }
    }

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
      // Capture the palette's HWND *before* hiding — we need it to exclude
      // ourselves from the topmost-fallback lookup below.
      const ownHwnd = hwndOf(this.window)
      // Collapse the blur-grace window so the blur event that `hide()`
      // itself fires can't trigger a re-focus into the now-hidden window.
      this.lastShownAt = 0
      this.window.hide()
      if (restoreFocus && this.previousWindowId) {
        try {
          if (
            process.platform !== 'win32' ||
            isWindowOnCurrentDesktop(this.previousWindowId)
          ) {
            // Remembered window still lives on the current desktop — restore
            // focus to it directly, which preserves exact "Esc goes back to
            // what I had" semantics.
            nativeFocus(this.previousWindowId)
          } else if (ownHwnd) {
            // Remembered window is on a *different* virtual desktop. Calling
            // SetForegroundWindow on it would yank the user across desktops.
            // Instead, hand focus to whatever's on top of the current desktop
            // — closest approximation of "dismiss and return to my work".
            // Plain `win.hide()` on an alwaysOnTop window doesn't reliably
            // promote anything, so we do it explicitly.
            const result = focusTopmostOnCurrentDesktop(ownHwnd)
            // Temporary diagnostic: print each candidate considered so we
            // can see which windows AHK (or anything else) is injecting
            // into the Z-order and whether our filter strips them.
            for (const line of result.log) {
              console.log(`[palette] focus_topmost: ${line}`)
            }
          }
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
