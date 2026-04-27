import { useEffect, useRef, useState } from 'react'
import { FolderOpen, Tag } from 'lucide-react'
import type { LucideIcon } from 'lucide-react'
import { cn } from '@/lib/utils'

/**
 * Ctrl+K context menu for the currently-selected palette row. One-option
 * placeholder today ("Show in file explorer") — the `actions` table here
 * is where new verbs (Copy Path, Open Containing Folder, etc.) get added
 * once modules start attaching richer per-item metadata.
 *
 * Positioned over the palette rather than as a dropdown anchored to a
 * row: simpler, and matches the look of PowerToys Command Palette's
 * "more actions" sheet. Renders only when `open` is true — caller drives
 * open/close via the Ctrl+K hotkey.
 *
 * Keyboard handling is self-contained:
 *   - ArrowUp / ArrowDown cycle the selection
 *   - Enter activates
 *   - Esc / Ctrl+K close
 *
 * PaletteApp's key handler short-circuits these keys to this component
 * whenever the menu is open, so the search input doesn't receive them.
 */

export interface ContextMenuAction {
  id: string
  label: string
  Icon: LucideIcon
  disabled?: boolean
  onActivate: () => void
}

interface Props {
  open: boolean
  onClose: () => void
  actions: ContextMenuAction[]
}

export function ContextMenu({ open, onClose, actions }: Props) {
  const [selected, setSelected] = useState(0)
  const rootRef = useRef<HTMLDivElement>(null)

  // Reset the highlighted option whenever the menu re-opens so the user
  // always lands on the first action regardless of where the previous
  // session left off.
  useEffect(() => {
    if (open) setSelected(0)
  }, [open])

  // Menu owns the keyboard while it's open. Capture on document so we
  // intercept before the palette's onKeyDown sees anything — otherwise
  // Enter would double-fire (execute row + activate menu).
  useEffect(() => {
    if (!open) return
    const handler = (e: KeyboardEvent): void => {
      if (e.key === 'Escape' || (e.key === 'k' && (e.ctrlKey || e.metaKey))) {
        e.preventDefault()
        e.stopPropagation()
        onClose()
        return
      }
      if (e.key === 'ArrowDown') {
        e.preventDefault()
        e.stopPropagation()
        setSelected((i) => (i + 1) % actions.length)
        return
      }
      if (e.key === 'ArrowUp') {
        e.preventDefault()
        e.stopPropagation()
        setSelected((i) => (i - 1 + actions.length) % actions.length)
        return
      }
      if (e.key === 'Enter') {
        e.preventDefault()
        e.stopPropagation()
        const action = actions[selected]
        if (action && !action.disabled) {
          action.onActivate()
          onClose()
        }
        return
      }
    }
    document.addEventListener('keydown', handler, true)
    return () => document.removeEventListener('keydown', handler, true)
  }, [open, actions, selected, onClose])

  // Click-outside to dismiss.
  useEffect(() => {
    if (!open) return
    const handler = (e: MouseEvent): void => {
      if (rootRef.current && !rootRef.current.contains(e.target as Node)) {
        onClose()
      }
    }
    document.addEventListener('mousedown', handler)
    return () => document.removeEventListener('mousedown', handler)
  }, [open, onClose])

  if (!open || actions.length === 0) return null

  return (
    <>
      {/* Scrim — catches pointer events so the palette behind doesn't
          receive them, plus dims the row list slightly for focus. */}
      <div className="absolute inset-0 bg-background/40 backdrop-blur-[1px] pointer-events-none" />
      <div
        ref={rootRef}
        role="menu"
        className="absolute bottom-12 right-3 z-10 min-w-[220px] bg-popover text-popover-foreground border border-border rounded-md shadow-lg overflow-hidden"
      >
        {actions.map((action, idx) => (
          <button
            key={action.id}
            type="button"
            role="menuitem"
            disabled={action.disabled}
            onClick={() => {
              if (action.disabled) return
              action.onActivate()
              onClose()
            }}
            className={cn(
              'w-full flex items-center gap-2 px-3 py-2 text-sm text-left transition-colors',
              action.disabled
                ? 'opacity-50 cursor-not-allowed'
                : idx === selected && 'bg-accent text-accent-foreground'
            )}
          >
            <action.Icon size={14} className="shrink-0" />
            <span className="flex-1 truncate">{action.label}</span>
          </button>
        ))}
      </div>
    </>
  )
}

/**
 * Helper exported for callers that just want the default "Show in file
 * explorer" action built from a reveal path. Kept out of the module's
 * internals so the component stays generic.
 */
export function revealAction(path: string): ContextMenuAction {
  return {
    id: 'reveal',
    label: 'Show in file explorer',
    Icon: FolderOpen,
    onActivate: () => {
      void window.electronAPI.revealInFolder(path)
    }
  }
}

/**
 * "Set alias…" action — caller owns the modal opening. We expose a
 * labelled variant so the menu reads "Change alias" once one already
 * exists (common expectation in palette / launcher apps).
 */
export function setAliasAction(
  hasExisting: boolean,
  openModal: () => void
): ContextMenuAction {
  return {
    id: 'set-alias',
    label: hasExisting ? 'Change alias…' : 'Set alias…',
    Icon: Tag,
    onActivate: openModal
  }
}
