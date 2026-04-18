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

    // Reuse a single MediaStream across recordings — getUserMedia's first
    // call on macOS/Linux can take hundreds of ms while the OS opens the
    // input device; keeping the stream warm means second+ hotkey presses
    // start capturing instantly. The stream is torn down on unload.
    let stream: MediaStream | null = null
    let recorder: MediaRecorder | null = null
    let activeRequestId: number | null = null
    let chunks: Blob[] = []
    let mimeType = ''

    const ensureStream = async (): Promise<MediaStream> => {
      if (stream && stream.active) return stream
      stream = await navigator.mediaDevices.getUserMedia({
        audio: {
          echoCancellation: true,
          noiseSuppression: true,
          channelCount: 1
        }
      })
      return stream
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
      try {
        const s = await ensureStream()
        mimeType = pickMimeType()
        const options: MediaRecorderOptions = mimeType ? { mimeType } : {}
        recorder = new MediaRecorder(s, options)
        chunks = []
        activeRequestId = payload.requestId

        recorder.ondataavailable = (ev) => {
          if (ev.data && ev.data.size > 0) chunks.push(ev.data)
        }
        recorder.onstop = async () => {
          const reqId = activeRequestId
          activeRequestId = null
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
          if (reqId != null) {
            const anyEv = ev as unknown as { error?: Error }
            api.sendError(reqId, anyEv.error?.message ?? 'MediaRecorder error')
          }
        }
        recorder.start()
      } catch (err) {
        activeRequestId = null
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
          if (reqId != null) api.sendError(reqId, (err as Error).message)
        }
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
