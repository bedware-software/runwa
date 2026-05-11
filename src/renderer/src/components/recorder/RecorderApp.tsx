import { useEffect } from 'react'

/**
 * Headless component mounted into the hidden recorder BrowserWindow.
 * Renders nothing — its only purpose is to run the MediaRecorder lifecycle
 * on IPC commands from main.
 *
 * Protocol (see `recorder-window.ts`):
 *   main → renderer: 'groq-stt:recorder:start' { requestId }
 *   main → renderer: 'groq-stt:recorder:stop'
 *   renderer → main: 'groq-stt:recorder:audio' { requestId, data, mimeType }
 *   renderer → main: 'groq-stt:recorder:error' { requestId, message }
 *   renderer → main: 'groq-stt:recorder:ready' (once on mount)
 */
export function RecorderApp() {
  useEffect(() => {
    const api = window.groqRecorder
    if (!api) {
      console.error('[recorder] preload API missing')
      return
    }

    // Open the mic only while a recording is in flight. Keeping a warm
    // MediaStream between hotkey presses would mean macOS' orange
    // "microphone in use" indicator stays on permanently, which the user
    // (rightly) reads as the app eavesdropping. Trade-off: each new
    // recording pays the getUserMedia cost again — a couple of hundred
    // ms on macOS/Linux while the OS opens the input device. The
    // user-facing fix is worth that latency.
    let stream: MediaStream | null = null
    let recorder: MediaRecorder | null = null
    let activeRequestId: number | null = null
    let chunks: Blob[] = []
    let mimeType = ''
    // Edge-trigger memory for the start↔stop race. When `onStop`
    // arrives while `onStart` is still inside `await openStream()` or
    // `await MediaRecorder.start()`, the recorder isn't ready to be
    // stopped — the naive "check recorder && state != inactive" path
    // sees nothing to do, and the audio promise on the main side
    // never resolves (stuck in `transcribing` forever). The flag
    // lets onStart bail cleanly the moment the mic comes online.
    // Triggered in practice by synthetic key chords from
    // keyboard-remap that hold our push-to-talk hotkey for only
    // microseconds — far shorter than getUserMedia's ~200ms boot.
    let pendingStop = false

    const openStream = async (): Promise<MediaStream> => {
      stream = await navigator.mediaDevices.getUserMedia({
        audio: {
          echoCancellation: true,
          noiseSuppression: true,
          channelCount: 1
        }
      })
      return stream
    }

    const releaseStream = (): void => {
      if (!stream) return
      for (const track of stream.getTracks()) track.stop()
      stream = null
    }

    const pickMimeType = (): string => {
      // Groq accepts webm/opus, ogg/opus, mp4, wav, m4a, mp3, flac. Prefer
      // webm/opus (ubiquitous in Chromium, small over the wire).
      const candidates = [
        'audio/webm;codecs=opus',
        'audio/webm',
        'audio/ogg;codecs=opus',
        'audio/ogg'
      ]
      for (const c of candidates) {
        if (MediaRecorder.isTypeSupported(c)) return c
      }
      return ''
    }

    const onStart = async (payload: { requestId: number }): Promise<void> => {
      activeRequestId = payload.requestId
      pendingStop = false
      try {
        const s = await openStream()
        // If onStop already came in while getUserMedia was blocking, bail.
        // No audio was captured; tell main so it can drop the indicator.
        if (pendingStop) {
          pendingStop = false
          releaseStream()
          const reqId = activeRequestId
          activeRequestId = null
          if (reqId != null) {
            api.sendError(reqId, 'released too fast (mic not ready)')
          }
          return
        }
        mimeType = pickMimeType()
        const options: MediaRecorderOptions = mimeType ? { mimeType } : {}
        recorder = new MediaRecorder(s, options)
        chunks = []

        recorder.ondataavailable = (ev) => {
          if (ev.data && ev.data.size > 0) chunks.push(ev.data)
        }
        recorder.onstop = async () => {
          const reqId = activeRequestId
          activeRequestId = null
          // Release the mic as soon as the recorder finishes finalizing —
          // anything past this point is just packaging the blob for IPC,
          // and macOS keeps showing the orange indicator until every track
          // is explicitly stopped.
          releaseStream()
          if (reqId == null) return
          const blob = new Blob(chunks, {
            type: mimeType || 'application/octet-stream'
          })
          chunks = []
          if (blob.size === 0) {
            api.sendError(reqId, 'no audio captured (release was too fast?)')
            return
          }
          try {
            const buffer = new Uint8Array(await blob.arrayBuffer())
            api.sendAudio(reqId, buffer, blob.type || mimeType)
          } catch (err) {
            api.sendError(reqId, (err as Error).message)
          }
        }
        recorder.onerror = (ev) => {
          const reqId = activeRequestId
          activeRequestId = null
          releaseStream()
          if (reqId != null) {
            const anyEv = ev as unknown as { error?: Error }
            api.sendError(reqId, anyEv.error?.message ?? 'MediaRecorder error')
          }
        }
        recorder.start()
        // Race window #2: onStop could have landed between the
        // MediaRecorder constructor and recorder.start(). At this
        // point recorder.state === 'recording', so the regular
        // onStop path would handle it — but only if onStop fires
        // AFTER us. The flag covers the case where it fired during.
        if (pendingStop) {
          pendingStop = false
          try {
            recorder.stop()
          } catch (err) {
            const reqId = activeRequestId
            activeRequestId = null
            releaseStream()
            if (reqId != null) api.sendError(reqId, (err as Error).message)
          }
        }
      } catch (err) {
        pendingStop = false
        activeRequestId = null
        releaseStream()
        api.sendError(payload.requestId, (err as Error).message)
      }
    }

    const onStop = (): void => {
      if (recorder && recorder.state !== 'inactive') {
        try {
          recorder.stop()
        } catch (err) {
          const reqId = activeRequestId
          activeRequestId = null
          releaseStream()
          if (reqId != null) api.sendError(reqId, (err as Error).message)
        }
        return
      }
      // Recorder not yet built (still inside onStart's await chain).
      // Stamp the flag so onStart aborts as soon as control returns.
      if (activeRequestId != null) {
        pendingStop = true
      }
    }

    const offStart = api.onStart(onStart)
    const offStop = api.onStop(onStop)
    api.signalReady()

    return () => {
      offStart()
      offStop()
      if (recorder && recorder.state !== 'inactive') {
        try {
          recorder.stop()
        } catch {
          /* ignore */
        }
      }
      if (stream) {
        for (const track of stream.getTracks()) track.stop()
        stream = null
      }
    }
  }, [])

  return null
}
