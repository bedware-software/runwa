import { useEffect, useState } from 'react'
import type {
  DesktopHintIcon as DesktopHintIconName,
  DesktopHintPayload
} from '@shared/types'
import { Clipboard, Loader2, Mic } from '@/lib/lucide-icons'

/**
 * Renderer for the shared, always-on-top Desktop Hint. Main owns placement
 * and lifetime; this component only applies the native-inspired surface and
 * follows the app's current light/dark theme.
 */
export function DesktopHintApp() {
  const [payload, setPayload] = useState<DesktopHintPayload | null>(null)

  useEffect(() => {
    const api = window.desktopHint
    if (!api) {
      console.error('[desktop-hint] preload API missing')
      return
    }

    const offPayload = api.onPayload(setPayload)
    api.signalReady()

    return () => {
      offPayload()
    }
  }, [])

  if (!payload) return null

  return (
    <div className="fixed inset-0 flex items-center justify-center pointer-events-none">
      <div
        key={`${payload.source}:${payload.message}:${payload.icon ?? ''}`}
        className="desktop-hint-surface inline-flex min-w-40 max-w-[300px] min-h-14 items-center justify-center gap-2.5 rounded-xl px-5 py-3 select-none"
        role="status"
        aria-live="polite"
      >
        {payload.icon && <DesktopHintIcon name={payload.icon} />}
        <span className="text-[15px] font-normal leading-5 tracking-[-0.01em] text-center">
          {payload.message}
        </span>
      </div>
    </div>
  )
}

function DesktopHintIcon({ name }: { name: DesktopHintIconName }) {
  if (name === 'microphone') {
    return (
      <span className="relative flex h-4 w-4 shrink-0 items-center justify-center">
        <span className="absolute inline-flex h-full w-full rounded-full bg-red-500 opacity-55 animate-ping" />
        <Mic size={15} className="relative text-red-500" />
      </span>
    )
  }

  if (name === 'spinner') {
    return (
      <Loader2
        size={15}
        className="shrink-0 text-desktop-hint-muted animate-spin"
      />
    )
  }

  return (
    <Clipboard
      size={15}
      className="shrink-0 text-desktop-hint-muted"
    />
  )
}
