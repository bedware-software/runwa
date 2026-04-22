import type { ReactNode } from 'react'
import { cn } from '@/lib/utils'

/**
 * Unified wrapper for the hints in the palette's bottom toolbar. Every
 * entry — clickable (Settings) or passive (Navigate / Select / Back) —
 * renders with the same padding, border radius, and hover background
 * so the toolbar reads as a row of equal-weight items. Without the
 * component the clickable and passive hints visually diverged (e.g.
 * Settings had its own hover-color-only treatment while the others had
 * nothing), which is what made PowerToys-style toolbars feel more
 * polished than ours.
 *
 * Render-as-button when `onClick` is set, otherwise a plain `span` so
 * the OS doesn't treat passive hints as interactive.
 */
interface Props {
  leading?: ReactNode
  label: ReactNode
  keys?: ReactNode
  onClick?: () => void
  className?: string
}

export function FooterHint({ leading, label, keys, onClick, className }: Props) {
  // Hover reaction is applied regardless of clickability — passive
  // hints still light up so the whole toolbar feels like a single
  // interactive surface, matching PowerToys Command Palette's polish.
  const shared = cn(
    'flex items-center gap-1.5 h-7 px-2 rounded-md transition-colors',
    'hover:bg-accent/50 hover:text-foreground',
    className
  )
  const content = (
    <>
      {leading}
      {label}
      {keys}
    </>
  )
  if (onClick) {
    return (
      <button type="button" onClick={onClick} className={shared}>
        {content}
      </button>
    )
  }
  return <span className={shared}>{content}</span>
}
