import { CURRENT_OS } from './platform'

/**
 * Windows: hand the window's frame color to main, which paints DWM's 1px
 * window border in it (see `setWindowBorderColor` in the main process). The
 * window then drops its own CSS frame on Windows (`IS_WINDOWS_FRAME`), so
 * there is one line with DWM's rounded corners instead of a CSS line, the
 * system's light #F3F3F3 frame strip and two sets of corners.
 *
 * The color is read off a hidden probe element carrying the frame's own
 * classes — never a guessed CSS variable name — and blended onto the probe's
 * background, because a theme token can be a translucent `color-mix`. It is
 * re-sent whenever the theme on <html> or the OS appearance changes, since
 * the palette and Settings live for the whole session.
 */

export const IS_WINDOWS_FRAME = CURRENT_OS === 'windows'

function toHex(r: number, g: number, b: number): string {
  return '#' + [r, g, b].map((v) => v.toString(16).padStart(2, '0')).join('')
}

function resolveFrameColor(probe: HTMLElement): string | null {
  const style = getComputedStyle(probe)
  const canvas = document.createElement('canvas')
  canvas.width = 1
  canvas.height = 1
  const ctx = canvas.getContext('2d', { willReadFrequently: true })
  if (!ctx) return null
  // Opaque base so a translucent background still lands on something.
  ctx.fillStyle = '#ffffff'
  ctx.fillRect(0, 0, 1, 1)
  ctx.fillStyle = style.backgroundColor
  ctx.fillRect(0, 0, 1, 1)
  ctx.fillStyle = style.borderTopColor
  ctx.fillRect(0, 0, 1, 1)
  const [r, g, b] = ctx.getImageData(0, 0, 1, 1).data
  return toHex(r, g, b)
}

/**
 * Start syncing the DWM border color for this window from an element styled
 * with `frameClasses` (the frame's border + background classes). Returns a
 * cleanup function. No-op off Windows.
 */
export function syncWindowBorder(frameClasses: string): () => void {
  if (!IS_WINDOWS_FRAME) return () => {}

  const probe = document.createElement('div')
  probe.className = frameClasses
  probe.setAttribute('aria-hidden', 'true')
  probe.style.cssText =
    'position:fixed;left:-9999px;top:0;width:4px;height:4px;visibility:hidden;pointer-events:none'
  document.body.appendChild(probe)

  let last: string | null = null
  const send = (): void => {
    const hex = resolveFrameColor(probe)
    if (hex === last) return
    last = hex
    window.electronAPI.setWindowBorderColor?.(hex)
  }

  // Let the theme attributes land before the first read.
  const raf = requestAnimationFrame(send)
  const observer = new MutationObserver(() => send())
  observer.observe(document.documentElement, {
    attributes: true,
    attributeFilter: ['data-theme', 'data-theme-variant', 'class', 'style']
  })
  const osDark = window.matchMedia('(prefers-color-scheme: dark)')
  osDark.addEventListener('change', send)

  return () => {
    cancelAnimationFrame(raf)
    observer.disconnect()
    osDark.removeEventListener('change', send)
    probe.remove()
  }
}
