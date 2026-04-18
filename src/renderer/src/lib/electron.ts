import type { ElectronAPI } from '@shared/types'

/**
 * Bridge exposed only to the hidden recorder window. Mirrors the shape in
 * preload/index.ts (RecorderAPI). Declared here so RecorderApp.tsx can
 * consume `window.groqRecorder` with types.
 */
interface GroqRecorderAPI {
  signalReady: () => void
  sendAudio: (requestId: number, data: Uint8Array, mimeType: string) => void
  sendError: (requestId: number, message: string) => void
  onStart: (cb: (payload: { requestId: number }) => void) => () => void
  onStop: (cb: () => void) => () => void
}

type GroqIndicatorState = 'hidden' | 'recording' | 'transcribing'
interface GroqIndicatorAPI {
  signalReady: () => void
  onState: (cb: (state: GroqIndicatorState) => void) => () => void
}

declare global {
  interface Window {
    electronAPI: ElectronAPI
    groqRecorder?: GroqRecorderAPI
    groqIndicator?: GroqIndicatorAPI
  }
}

export {}
