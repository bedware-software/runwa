import { useEffect, useState } from 'react'
import { Mic, Loader2 } from 'lucide-react'

type IndicatorState = 'hidden' | 'recording' | 'transcribing'

/**
 * Bottom-of-screen pill that shows Groq transcription state. Driven over
 * IPC by `indicator-window.ts` — main controls the lifetime, we only
 * render the current state.
 */
export function IndicatorApp() {
  const [state, setState] = useState<IndicatorState>('hidden')

  useEffect(() => {
    const api = window.groqIndicator
    if (!api) {
      console.error('[indicator] preload API missing')
      return
    }
    const off = api.onState((next) => setState(next))
    api.signalReady()
    return off
  }, [])

  if (state === 'hidden') return null

  return (
    <div className="fixed inset-0 flex items-end justify-center pointer-events-none">
      <div className="flex items-center gap-2.5 px-4 h-9 rounded-full bg-zinc-900/90 backdrop-blur-md shadow-lg border border-white/10 text-zinc-100 text-xs font-medium select-none">
        {state === 'recording' ? <RecordingIcon /> : <TranscribingIcon />}
        <span className="tracking-tight">
          {state === 'recording' ? 'Listening…' : 'Transcribing…'}
        </span>
      </div>
    </div>
  )
}

function RecordingIcon() {
  return (
    <span className="relative flex h-4 w-4 items-center justify-center">
      <span className="absolute inline-flex h-full w-full rounded-full bg-red-500 opacity-60 animate-ping" />
      <Mic size={14} className="relative text-red-400" />
    </span>
  )
}

function TranscribingIcon() {
  return <Loader2 size={14} className="text-zinc-300 animate-spin" />
}
