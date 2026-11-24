import { useEffect, useState } from 'react'
import { Toast } from '@bedware/ui'
import type { DesktopHintPayload } from '@shared/types'
import { Clipboard, Mic } from '@/lib/lucide-icons'
import { cn } from '@/lib/utils'

/**
 * Renderer for the Notifications strip (the shared, always-on-top Desktop
 * Hint window). Main owns placement and lifetime; the surface itself is the
 * design system's Toast, in the look chosen in the Notifications module.
 *
 * The window is a fixed transparent box placed against a screen edge; the
 * toast sits at that edge of it and grows inward. The 24px padding
 * (SURFACE_INSET in desktop-hint-window.ts) keeps every look clear of the
 * window's edge — the "tag" look's title sticks out 7px above the toast.
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

  const [vertical, horizontal] = (payload.position ?? 'bottom-center').split('-')

  return (
    <div
      className={cn(
        'fixed inset-0 flex p-6 pointer-events-none',
        vertical === 'top' ? 'items-start' : 'items-end',
        horizontal === 'left'
          ? 'justify-start'
          : horizontal === 'right'
            ? 'justify-end'
            : 'justify-center'
      )}
    >
      <Toast
        // A new key replays the toast's entrance when the content changes.
        key={`${payload.source}:${payload.title ?? ''}:${payload.message}:${payload.icon ?? ''}:${payload.look ?? ''}`}
        look={payload.look}
        tone={payload.tone}
        title={payload.title}
        icon={
          payload.icon === 'microphone' ? (
            <Mic size={15} />
          ) : payload.icon === 'clipboard' ? (
            <Clipboard size={15} />
          ) : undefined
        }
        state={
          payload.icon === 'microphone'
            ? 'recording'
            : payload.icon === 'spinner'
              ? 'waiting'
              : undefined
        }
        aria-live="polite"
      >
        {payload.message}
      </Toast>
    </div>
  )
}
