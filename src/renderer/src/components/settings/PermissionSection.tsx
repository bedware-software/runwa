import { useEffect, useState } from 'react'
import { Badge, Button, Panel, PanelRow, SectionTitle } from '@bedware/ui'
import type { PermissionFlags, PermissionName } from '@shared/types'

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
    <div>
      <SectionTitle title={heading} description={description} />
      <Panel>
        {rows.map((row) => {
          const granted = permissions[row.name]
          return (
            <PanelRow key={row.name} title={row.title} description={row.description}>
              <div className="flex items-center gap-2 shrink-0">
                <Badge tone={granted ? 'accent' : 'error'}>
                  {granted ? 'Granted' : 'Not granted'}
                </Badge>
                <Button data-vim-item={`perm:${row.name}`} onClick={() => void handleAction(row.name, granted)}>
                  {granted ? 'Open' : 'Grant'}
                </Button>
              </div>
            </PanelRow>
          )
        })}
      </Panel>
    </div>
  )
}
