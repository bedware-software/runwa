import { useEffect, useRef, useState, type ReactNode } from 'react'
import { createPortal } from 'react-dom'
import { cn } from '@/lib/utils'

interface Props {
  /** Tooltip body. Plain text or any ReactNode. When falsy the
   * tooltip is fully disabled — children render as-is with no
   * hover handlers attached, useful for conditional callsites. */
  content?: ReactNode
  children: ReactNode
  /** How long the pointer must rest on the trigger before the
   * tooltip pops. Default 250 ms — long enough to ignore drag-by
   * traversals, short enough to feel responsive. */
  delay?: number
  /** Extra classes for the wrapper span. The wrapper is `inline-flex`
   * by default so it doesn't disturb the parent's flex layout. Pass
   * `shrink-0` when wrapping a sized flex child you don't want to
   * collapse. */
  className?: string
}

/**
 * App-styled hover tooltip. Native `title="…"` is the obvious
 * cheap-and-cheerful option, but has two problems for this UI:
 *   - ~500 ms OS-controlled delay that can't be tuned
 *   - browser/OS-styled rendering that clashes with the popover look
 *
 * We render our own bubble via React portal so it can escape the
 * palette's `overflow-hidden` clip, and position it from the
 * trigger's `getBoundingClientRect()`. Pointer events on the bubble
 * are disabled so moving the cursor over the tooltip itself still
 * counts as "leaving" the trigger (no flicker, simple state machine).
 *
 * Caller wraps the trigger element; the wrapper is a plain `<span>`
 * with `inline-flex` so it doesn't introduce extra block flow into
 * flex / inline parents.
 */
export function Tooltip({ content, children, delay = 250, className }: Props) {
  const [visible, setVisible] = useState(false)
  const [coords, setCoords] = useState<{ top: number; left: number } | null>(
    null
  )
  const triggerRef = useRef<HTMLSpanElement>(null)
  const timerRef = useRef<number | null>(null)

  const cancelShow = (): void => {
    if (timerRef.current !== null) {
      window.clearTimeout(timerRef.current)
      timerRef.current = null
    }
  }

  // Cleanup on unmount: kills the pending timer so a click-away
  // mid-delay can't fire setVisible on an unmounted node.
  useEffect(() => () => cancelShow(), [])

  const scheduleShow = (): void => {
    if (!content) return
    cancelShow()
    timerRef.current = window.setTimeout(() => {
      const rect = triggerRef.current?.getBoundingClientRect()
      if (!rect) return
      // Anchor the tooltip's LEFT edge to the trigger's left and
      // drop it directly below — no horizontal centering. Centering
      // a wide tooltip on a small icon at the row's left edge would
      // push half the bubble off-screen, which the centring-and-
      // clamping dance would otherwise need to fix. Left-anchor + a
      // right-edge clamp covers the same ground in fewer lines.
      const MAX_WIDTH = 320
      const PAD = 8
      let left = rect.left
      if (left + MAX_WIDTH > window.innerWidth - PAD) {
        left = Math.max(PAD, window.innerWidth - MAX_WIDTH - PAD)
      }
      setCoords({ top: rect.bottom + 6, left })
      setVisible(true)
    }, delay)
  }

  const hide = (): void => {
    cancelShow()
    setVisible(false)
  }

  return (
    <>
      <span
        ref={triggerRef}
        onMouseEnter={scheduleShow}
        onMouseLeave={hide}
        // Click on the trigger is usually a "row select" — hide
        // immediately so the bubble doesn't linger over the freshly-
        // highlighted row.
        onMouseDown={hide}
        className={cn('inline-flex', className)}
      >
        {children}
      </span>
      {visible &&
        content &&
        coords &&
        createPortal(
          <div
            role="tooltip"
            className={cn(
              'fixed z-[1000] pointer-events-none',
              'max-w-[320px] px-3 py-2 rounded-md text-xs leading-relaxed',
              'bg-popover text-popover-foreground border border-border shadow-md'
            )}
            style={{ top: coords.top, left: coords.left }}
          >
            {content}
          </div>,
          document.body
        )}
    </>
  )
}
