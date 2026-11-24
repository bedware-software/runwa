import { useEffect, useState } from 'react'
import { Button, LinkButton, Panel, PanelRow, SectionTitle } from '@bedware/ui'
import { Download, RefreshCw } from '@/lib/lucide-icons'
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
        <SectionTitle
          title={info?.name ?? '…'}
          description="A cross-platform command palette launcher."
        />
        <Panel>
          <PanelRow title="Version">
            <div className="text-sm text-muted-foreground tabular-nums">
              {info ? `v${info.version}` : '…'}
            </div>
          </PanelRow>
          <PanelRow title="bedware UI">
            <div className="text-sm text-muted-foreground tabular-nums">
              v{__BEDWARE_UI_VERSION__}
            </div>
          </PanelRow>
          <PanelRow>
            <div className="text-sm font-medium text-foreground shrink-0">
              Settings folder
            </div>
            {info?.userDataPath ? (
              <LinkButton data-vim-item="about:folder"
                mono
                onClick={() =>
                  void window.electronAPI.revealInFolder(info.userDataPath)
                }
                title="Reveal in file manager"
                className="min-w-0 truncate"
              >
                {info.userDataPath}
              </LinkButton>
            ) : (
              <div className="text-xs text-muted-foreground">…</div>
            )}
          </PanelRow>
        </Panel>
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
      <SectionTitle
        title="Updates"
        description="runwa checks the GitHub releases on launch and every few hours. The button below triggers a manual check."
      />
      <Panel>
        <PanelRow title={label} description={description} className="items-start">
          <Button data-vim-item="about:update"
            variant={action === 'install' ? 'primary' : 'secondary'}
            onClick={action === 'install' ? onInstall : onCheck}
            disabled={busy}
            icon={
              action === 'install' ? (
                <Download size={12} />
              ) : (
                <RefreshCw size={12} className={cn(spin && 'animate-spin')} />
              )
            }
            className="shrink-0"
          >
            {buttonLabel}
          </Button>
        </PanelRow>
      </Panel>
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
