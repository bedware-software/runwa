import { BrowserWindow, ipcMain, session as electronSession } from 'electron'
import path from 'path'

/**
 * Hidden BrowserWindow that owns the microphone. Main-process Electron
 * can't call `navigator.mediaDevices.getUserMedia` — that API only exists
 * on a renderer. We spin up a never-shown window with a tiny page
 * (renderer/#recorder) that:
 *
 *   1. Opens the default microphone the first time it's asked to record.
 *   2. Starts/stops a MediaRecorder on demand.
 *   3. Streams the resulting audio Blob (webm/opus) back to main as a Uint8Array.
 *
 * IPC channels (main ↔ recorder):
 *   main  → renderer: 'groq-stt:recorder:start'   { requestId }
 *   main  → renderer: 'groq-stt:recorder:stop'
 *   renderer → main:  'groq-stt:recorder:ready'   (once, after mount)
 *   renderer → main:  'groq-stt:recorder:audio'   { requestId, data, mimeType }
 *   renderer → main:  'groq-stt:recorder:error'   { requestId, message }
 *
 * Each start() gets a fresh requestId so overlapping invocations don't cross
 * wires — late results from stale requests are dropped.
 */

export interface RecordingResult {
  data: Uint8Array
  mimeType: string
}

type Pending = {
  requestId: number
  resolve: (result: RecordingResult) => void
  reject: (err: Error) => void
}

class RecorderWindow {
  private window: BrowserWindow | null = null
  private ready = false
  private readyWaiters: Array<() => void> = []
  private pending: Pending | null = null
  private requestSeq = 0
  private ipcWired = false

  init(): void {
    if (this.window && !this.window.isDestroyed()) return

    // IPC handlers are process-wide; wire them exactly once even if the
    // window has been destroyed and reinitialized.
    this.wireIpc()

    // Grant the recorder window mic access without prompting the user — the
    // user already opted in by setting an API key and binding a hotkey.
    // Scoped to the recorder window's webContents so this doesn't affect
    // the palette or settings renderers.
    electronSession.defaultSession.setPermissionRequestHandler(
      (wc, permission, callback) => {
        if (
          this.window &&
          !this.window.isDestroyed() &&
          wc.id === this.window.webContents.id &&
          (permission === 'media' || permission === 'microphone')
        ) {
          callback(true)
          return
        }
        callback(false)
      }
    )

    this.window = new BrowserWindow({
      width: 1,
      height: 1,
      show: false,
      frame: false,
      skipTaskbar: true,
      resizable: false,
      movable: false,
      minimizable: false,
      maximizable: false,
      focusable: false,
      transparent: true,
      webPreferences: {
        preload: path.join(__dirname, '../preload/index.js'),
        contextIsolation: true,
        sandbox: true,
        nodeIntegration: false,
        // getUserMedia in Electron works fine in a normal renderer, but we
        // need autoplayPolicy off so the audio graph starts without a user
        // gesture (none will ever happen in an invisible window).
        autoplayPolicy: 'no-user-gesture-required'
      }
    })

    this.window.on('closed', () => {
      this.window = null
      this.ready = false
      if (this.pending) {
        this.pending.reject(new Error('recorder window closed'))
        this.pending = null
      }
      // Drain any waiters with a rejection-equivalent: they'd be waiting
      // to send 'start' to a window that no longer exists; surface that
      // by resolving them so their closures run and find window==null.
      const waiters = this.readyWaiters
      this.readyWaiters = []
      for (const w of waiters) {
        try {
          w()
        } catch {
          /* ignore */
        }
      }
    })

    if (process.env.ELECTRON_RENDERER_URL) {
      this.window.loadURL(process.env.ELECTRON_RENDERER_URL + '#recorder')
    } else {
      this.window.loadFile(path.join(__dirname, '../renderer/index.html'), {
        hash: 'recorder'
      })
    }
  }

  private wireIpc(): void {
    if (this.ipcWired) return
    this.ipcWired = true

    ipcMain.on('groq-stt:recorder:ready', (e) => {
      if (!this.window || e.sender.id !== this.window.webContents.id) return
      this.ready = true
      const waiters = this.readyWaiters
      this.readyWaiters = []
      for (const w of waiters) {
        try {
          w()
        } catch (err) {
          console.warn('[recorder-window] ready waiter threw:', err)
        }
      }
    })

    ipcMain.on(
      'groq-stt:recorder:audio',
      (
        e,
        payload: { requestId: number; data: Uint8Array; mimeType: string }
      ) => {
        if (!this.window || e.sender.id !== this.window.webContents.id) return
        if (!this.pending || this.pending.requestId !== payload.requestId) {
          // Late result from a stale request — drop silently.
          return
        }
        this.pending.resolve({ data: payload.data, mimeType: payload.mimeType })
        this.pending = null
      }
    )

    ipcMain.on(
      'groq-stt:recorder:error',
      (e, payload: { requestId: number; message: string }) => {
        if (!this.window || e.sender.id !== this.window.webContents.id) return
        if (!this.pending || this.pending.requestId !== payload.requestId) return
        this.pending.reject(new Error(payload.message))
        this.pending = null
      }
    )
  }

  /**
   * Begin a recording. Returns a promise that resolves to the full audio
   * buffer once `stop()` is called and the renderer finalizes. Rejects if
   * the recorder errors out or a newer start supersedes this one.
   *
   * Safe to call before the renderer has signaled ready — the 'start'
   * message is queued until it does.
   */
  start(): Promise<RecordingResult> {
    this.init()

    if (this.pending) {
      this.pending.reject(new Error('superseded by a new recording'))
      this.pending = null
    }

    const requestId = ++this.requestSeq
    const resultPromise = new Promise<RecordingResult>((resolve, reject) => {
      this.pending = { requestId, resolve, reject }
    })

    const sendStart = (): void => {
      if (!this.window || this.window.isDestroyed()) {
        if (this.pending && this.pending.requestId === requestId) {
          this.pending.reject(new Error('recorder window unavailable'))
          this.pending = null
        }
        return
      }
      this.window.webContents.send('groq-stt:recorder:start', { requestId })
    }

    if (this.ready) {
      sendStart()
    } else {
      this.readyWaiters.push(sendStart)
    }

    return resultPromise
  }

  /** Signal the renderer to stop MediaRecorder. The audio arrives async. */
  stop(): void {
    if (!this.window || this.window.isDestroyed()) return
    this.window.webContents.send('groq-stt:recorder:stop')
  }

  dispose(): void {
    if (this.pending) {
      this.pending.reject(new Error('app shutting down'))
      this.pending = null
    }
    if (this.window && !this.window.isDestroyed()) {
      this.window.destroy()
    }
    this.window = null
    this.ready = false
    this.readyWaiters = []
  }
}

export const recorderWindow = new RecorderWindow()
