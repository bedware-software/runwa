import { useEffect, useState } from 'react'
import { Download, RefreshCw } from 'lucide-react'
import type { AppInfo, UpdateStatus } from '@shared/types'
import { cn } from '@/lib/utils'

/**
 * The "About" pane — app identity (name + version) plus the auto-update
 * status / action row. The update section used to live in General; it moved
 * here so the tray's "Check for updates" entry and the About tab point at
 * the same surface.
 */
export function AboutPanel() {
  const [info, setInfo] = useState<AppInfo | null>(null)
  useEffect(() => {
    let cancelled = false
    void window.electronAPI.getAppInfo().then((v) => {
      if (!cancelled) setInfo(v)
    })
    return () => {
      cancelled = true
    }
  }, [])

  return (
    <div className="flex flex-col gap-8 max-w-xl">
      <section>
        <h2 className="text-sm font-semibold text-foreground mb-1">runwa</h2>
        <p className="text-xs text-muted-foreground mb-3">
          A cross-platform command palette launcher.
        </p>
        <div className="flex items-center justify-between gap-4 px-4 py-3 border border-input rounded-md bg-card">
          <div className="text-sm font-medium text-foreground">Version</div>
          <div className="text-sm text-muted-foreground tabular-nums">
            {info ? `v${info.version}` : '…'}
          </div>
        </div>
      </section>

      <UpdateSection />
    </div>
  )
}

/**
 * "Check for updates" affordance. The main process owns the state — we
 * bootstrap from `getUpdateStatus()` on mount and subscribe to
 * `onUpdateStatus` for live transitions (check → download-progress →
 * downloaded / up-to-date / error). The same component doubles as a
 * passive status readout: if a background check ran minutes ago, the
 * section already reflects "Up to date, v0.1.27" when the user opens
 * Settings.
 */
function UpdateSection() {
  const [status, setStatus] = useState<UpdateStatus>({ state: 'idle' })

  useEffect(() => {
    let cancelled = false
    void window.electronAPI.getUpdateStatus().then((s) => {
      if (!cancelled) setStatus(s)
    })
    const unsub = window.electronAPI.onUpdateStatus((s) => setStatus(s))
    return () => {
      cancelled = true
      unsub()
    }
  }, [])

  const onCheck = (): void => {
    void window.electronAPI.checkForUpdates()
  }

  const onInstall = (): void => {
    void window.electronAPI.installUpdate()
  }

  const view = renderStatus(status)
  const { label, description, buttonLabel, spin, busy } = view
  const action = view.action ?? 'check'

  return (
    <section>
      <h2 className="text-sm font-semibold text-foreground mb-1">Updates</h2>
      <p className="text-xs text-muted-foreground mb-3">
        runwa checks the GitHub releases on launch and every few hours.
        The button below triggers a manual check.
      </p>
      <div className="flex items-start gap-4 px-4 py-3 border border-input rounded-md bg-card">
        <div className="flex-1 min-w-0">
          <p className="text-sm font-medium text-foreground">{label}</p>
          {description && (
            <p className="text-[11px] text-muted-foreground mt-1">
              {description}
            </p>
          )}
        </div>
        <button
          type="button"
          onClick={action === 'install' ? onInstall : onCheck}
          disabled={busy}
          className={cn(
            'shrink-0 flex items-center gap-1.5 h-8 px-3 rounded-md text-xs font-medium border transition-colors',
            action === 'install'
              ? 'bg-primary text-primary-foreground border-primary hover:opacity-90'
              : 'bg-secondary text-secondary-foreground border-input hover:bg-accent',
            busy && 'opacity-60 cursor-not-allowed hover:bg-secondary'
          )}
        >
          {action === 'install' ? (
            <Download size={12} />
          ) : (
            <RefreshCw size={12} className={cn(spin && 'animate-spin')} />
          )}
          {buttonLabel}
        </button>
      </div>
    </section>
  )
}

interface StatusView {
  label: string
  description?: string
  buttonLabel: string
  spin: boolean
  busy: boolean
  /**
   * What the button does when clicked. `'check'` runs the standard
   * `checkForUpdates` RPC; `'install'` triggers the explicit
   * `installUpdate` path (kill siblings + quitAndInstall). Default is
   * `'check'`.
   */
  action?: 'check' | 'install'
}

function renderStatus(s: UpdateStatus): StatusView {
  switch (s.state) {
    case 'checking':
      return {
        label: 'Checking for updates…',
        buttonLabel: 'Checking…',
        spin: true,
        busy: true
      }
    case 'up-to-date':
      return {
        label: `You're up to date — v${s.currentVersion}`,
        buttonLabel: 'Check for updates',
        spin: false,
        busy: false
      }
    case 'available':
      return {
        label: `Update available — v${s.version}`,
        description: 'Downloading in the background.',
        buttonLabel: 'Checking…',
        spin: true,
        busy: true
      }
    case 'downloading':
      return {
        label: `Downloading v${s.version || 'update'}…`,
        description: `${s.percent}% complete.`,
        buttonLabel: 'Downloading…',
        spin: true,
        busy: true
      }
    case 'downloaded':
      return {
        label: `v${s.version} ready to install`,
        description:
          'runwa will close, apply the update, and relaunch. Any background helpers from "Wipe all data" are terminated first so the installer can replace files cleanly.',
        buttonLabel: 'Install now',
        spin: false,
        busy: false,
        action: 'install'
      }
    case 'error':
      return {
        label: 'Update check failed',
        description: s.message,
        buttonLabel: 'Try again',
        spin: false,
        busy: false
      }
    case 'disabled':
      return {
        label: 'Auto-update disabled in dev builds',
        description:
          'Running from `npm run dev` — the code on disk IS the update source, so no check is performed. Packaged releases get real auto-update.',
        buttonLabel: 'Unavailable',
        spin: false,
        busy: true
      }
    case 'idle':
    default:
      return {
        label: 'runwa is ready to check for updates',
        buttonLabel: 'Check for updates',
        spin: false,
        busy: false
      }
  }
}
