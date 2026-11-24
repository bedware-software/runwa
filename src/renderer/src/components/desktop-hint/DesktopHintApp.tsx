import { useEffect, useState } from 'react'
import type {
  DesktopHintIcon as DesktopHintIconName,
  DesktopHintPayload
} from '@shared/types'
import { AlertTriangle, Check, Clipboard, Loader2, Mic } from '@/lib/lucide-icons'
import { cn } from '@/lib/utils'

/**
 * Renderer for the Notifications strip (the shared, always-on-top Desktop
 * Hint window). Main owns placement and lifetime; this component only
 * applies the surface and follows the app's current light/dark theme.
 *
 * The window is a fixed transparent box placed against a screen edge; the
 * surface sits at that edge of it and grows inward. The 24px padding is the
 * room its shadow needs (SURFACE_INSET in desktop-hint-window.ts).
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
  const icon: DesktopHintIconName | 'error' | 'success' | undefined =
    payload.icon ??
    (payload.tone === 'error' || payload.tone === 'success' ? payload.tone : undefined)

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
      <div
        key={`${payload.source}:${payload.title ?? ''}:${payload.message}:${icon ?? ''}`}
        className="desktop-hint-surface inline-flex min-w-40 max-w-[300px] min-h-14 items-center justify-center gap-2.5 rounded-xl px-5 py-3 select-none"
        role="status"
        aria-live="polite"
        data-tone={payload.tone}
      >
        {icon && <DesktopHintIcon name={icon} />}
        <span className="min-w-0 text-[15px] leading-5 tracking-[-0.01em] text-center">
          {payload.title && (
            <span className="block truncate font-semibold">{payload.title}</span>
          )}
          <span className="block font-normal line-clamp-[8] break-words">
            {payload.message}
          </span>
        </span>
      </div>
    </div>
  )
}

function DesktopHintIcon({
  name
}: {
  name: DesktopHintIconName | 'error' | 'success'
}) {
  if (name === 'microphone') {
    return (
      <span className="relative flex h-4 w-4 shrink-0 items-center justify-center">
        <span className="absolute inline-flex h-full w-full bg-destructive opacity-55 animate-ping" />
        <Mic size={15} className="relative text-destructive" />
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

  if (name === 'error') {
    return <AlertTriangle size={15} className="shrink-0 text-destructive" />
  }

  if (name === 'success') {
    return <Check size={15} className="shrink-0 text-desktop-hint-muted" />
  }

  return (
    <Clipboard
      size={15}
      className="shrink-0 text-desktop-hint-muted"
    />
  )
}
