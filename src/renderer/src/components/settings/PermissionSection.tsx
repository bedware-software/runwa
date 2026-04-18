import { useEffect, useState } from 'react'
import type { PermissionFlags, PermissionName } from '@shared/types'
import { cn } from '@/lib/utils'

export interface PermissionRowSpec {
  name: PermissionName
  title: string
  description: string
}

interface Props {
  heading: string
  description: string
  rows: PermissionRowSpec[]
}

/**
 * Module-scoped system permission block. Shown inside a module's settings
 * panel (keyboard-remap → Accessibility, window-switcher → Screen Recording)
 * next to the features that actually need the grant. Self-hiding on
 * non-macOS platforms — `permissionsGet()` returns null when there's no
 * TCC gate, and we render nothing.
 *
 * Re-polls on window focus so granting in System Settings and tabbing back
 * flips the badge without a manual refresh. AX caches the trust bit at
 * process start, so the row's helper copy still tells the user to
 * relaunch runwa before the underlying APIs start working.
 */
export function PermissionSection({ heading, description, rows }: Props) {
  const [permissions, setPermissions] = useState<PermissionFlags | null>(null)

  useEffect(() => {
    let cancelled = false

    const refresh = async (): Promise<void> => {
      const status = await window.electronAPI.permissionsGet()
      if (!cancelled) setPermissions(status)
    }

    void refresh()
    const onFocus = (): void => void refresh()
    window.addEventListener('focus', onFocus)
    return () => {
      cancelled = true
      window.removeEventListener('focus', onFocus)
    }
  }, [])

  if (!permissions) return null

  const handleAction = async (
    name: PermissionName,
    granted: boolean
  ): Promise<void> => {
    const next = granted
      ? await window.electronAPI.permissionsGet()
      : await window.electronAPI.permissionsRequest(name)
    setPermissions(next)
    if (!granted) {
      await window.electronAPI.permissionsOpenSystemSettings(name)
    }
  }

  return (
    <div className="flex flex-col gap-2">
      <div className="text-xs font-medium text-foreground">{heading}</div>
      <div className="text-xs text-muted-foreground -mt-1">{description}</div>
      <div className="flex flex-col divide-y divide-border border border-input rounded-md bg-card overflow-hidden">
        {rows.map((row) => {
          const granted = permissions[row.name]
          return (
            <div
              key={row.name}
              className="flex items-center justify-between gap-4 px-4 py-3"
            >
              <div className="flex-1 min-w-0">
                <span className="text-sm font-medium text-foreground">
                  {row.title}
                </span>
                <div className="text-xs text-muted-foreground mt-0.5">
                  {row.description}
                </div>
              </div>
              <div className="flex items-center gap-2 shrink-0">
                <span
                  className={cn(
                    'text-[10px] font-medium uppercase tracking-wide px-1.5 py-0.5 rounded',
                    granted
                      ? 'bg-primary/15 text-primary'
                      : 'bg-destructive/15 text-destructive'
                  )}
                >
                  {granted ? 'Granted' : 'Not granted'}
                </span>
                <button
                  type="button"
                  onClick={() => void handleAction(row.name, granted)}
                  className="h-7 px-2 rounded-md text-xs font-medium border border-input bg-secondary text-secondary-foreground hover:bg-accent"
                >
                  {granted ? 'Open' : 'Grant'}
                </button>
              </div>
            </div>
          )
        })}
      </div>
    </div>
  )
}
