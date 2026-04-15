import { useCallback } from 'react'
import type { PointerEvent as ReactPointerEvent } from 'react'

/** Pixels of pointer travel before we switch from "click" to "drag". */
const DRAG_THRESHOLD = 4

/**
 * Hook that turns a pointerdown on any element into a JS-driven window move.
 *
 * Behavior:
 *  - Click without moving → `dragging` never fires, the underlying element
 *    receives focus/click normally (for an input: caret placement + focus).
 *  - Click + drag past 4px → we call paletteStartMove() once, then stream
 *    paletteMoveBy(dx, dy) on every pointermove. Text selection in the
 *    source element is suppressed while dragging.
 *  - Only reacts to primary-button mouse input; touch/stylus are ignored so
 *    they don't hijack on-screen keyboard interactions.
 */
export function useWindowDrag(): {
  onPointerDown: (e: ReactPointerEvent<HTMLElement>) => void
} {
  const onPointerDown = useCallback((e: ReactPointerEvent<HTMLElement>) => {
    if (e.button !== 0) return
    if (e.pointerType !== 'mouse') return

    // NOTE: we deliberately do NOT preventDefault here — we want the input
    // to focus and place its caret if the user ends up not dragging.
    const startScreenX = e.screenX
    const startScreenY = e.screenY
    let dragging = false
    let dragStarted = false

    // rAF-coalesced pending move. pointermove can fire at 120+ Hz on modern
    // mice/trackpads; coalescing into one IPC per paint frame keeps the
    // main-process setBounds calls from piling up and the drag smooth.
    let pendingMove: { dx: number; dy: number } | null = null
    let rafId: number | null = null

    const flushPending = (): void => {
      rafId = null
      if (pendingMove) {
        window.electronAPI.paletteMoveBy(pendingMove.dx, pendingMove.dy)
        pendingMove = null
      }
    }

    const enterDrag = (): void => {
      dragging = true
      // Suppress text selection globally while the drag is active.
      document.body.style.userSelect = 'none'
      // Hint the cursor so the user sees that the gesture became a move.
      document.body.style.cursor = 'grabbing'
    }

    const exitDrag = (): void => {
      document.body.style.userSelect = ''
      document.body.style.cursor = ''
    }

    const onMove = (ev: PointerEvent): void => {
      const dx = ev.screenX - startScreenX
      const dy = ev.screenY - startScreenY

      if (!dragging) {
        if (Math.hypot(dx, dy) < DRAG_THRESHOLD) return
        enterDrag()
      }

      if (!dragStarted) {
        window.electronAPI.paletteStartMove()
        dragStarted = true
      }

      // Coalesce: only the most recent dx/dy matters because our payload
      // is cumulative from drag start, not incremental.
      pendingMove = { dx, dy }
      if (rafId === null) {
        rafId = requestAnimationFrame(flushPending)
      }
      ev.preventDefault()
    }

    const cleanup = (): void => {
      window.removeEventListener('pointermove', onMove)
      window.removeEventListener('pointerup', onUp)
      window.removeEventListener('pointercancel', onUp)

      // Flush any frame-pending move so the final position matches where
      // the user released the pointer.
      if (rafId !== null) {
        cancelAnimationFrame(rafId)
        rafId = null
        if (pendingMove) {
          window.electronAPI.paletteMoveBy(pendingMove.dx, pendingMove.dy)
          pendingMove = null
        }
      }

      if (dragStarted) {
        window.electronAPI.paletteEndMove()
      }
      if (dragging) {
        exitDrag()
      }
    }

    const onUp = (): void => {
      cleanup()
    }

    window.addEventListener('pointermove', onMove)
    window.addEventListener('pointerup', onUp)
    window.addEventListener('pointercancel', onUp)
  }, [])

  return { onPointerDown }
}
