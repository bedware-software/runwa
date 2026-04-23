import { useEffect, useState } from 'react'
import { useSettingsStore } from '@/store/settings-store'
import { Sidebar, type SettingsTab } from './Sidebar'
import { SettingsTitleBar } from './SettingsTitleBar'
import { GeneralPanel } from './GeneralPanel'
import { AboutPanel } from './AboutPanel'
import { ModulePanel } from './ModulesPanel'

/**
 * Hash form is `#settings` or `#settings?tab=<id>` — the latter is how
 * main deep-links a freshly-opened window to a specific pane (e.g. the
 * tray's "About" / "Check for updates" entries). We parse it at mount
 * time so the first render already shows the right tab without a flash
 * of "General".
 */
function initialTabFromHash(): SettingsTab {
  const hash = window.location.hash.replace(/^#/, '')
  const q = hash.indexOf('?')
  if (q === -1) return 'general'
  const params = new URLSearchParams(hash.slice(q + 1))
  const tab = params.get('tab')
  if (tab === 'about' || tab === 'general') return tab
  if (tab && tab.startsWith('module:')) return tab as SettingsTab
  return 'general'
}

export function SettingsApp() {
  const [tab, setTab] = useState<SettingsTab>(() => initialTabFromHash())
  const hydrate = useSettingsStore((s) => s.hydrate)
  const applyServerSettings = useSettingsStore((s) => s.applyServerSettings)
  const theme = useSettingsStore((s) => s.settings?.theme ?? 'system')
  const isHydrated = useSettingsStore((s) => s.isHydrated)

  useEffect(() => {
    void hydrate()
  }, [hydrate])

  useEffect(() => {
    document.documentElement.setAttribute('data-theme', theme)
  }, [theme])

  useEffect(() => {
    const unsub = window.electronAPI.onSettingsChanged((settings) => {
      applyServerSettings(settings)
    })
    return unsub
  }, [applyServerSettings])

  // Main can deep-link us to a specific tab — the tray's "About" /
  // "Check for updates" entries both route here via `settings:open-tab`.
  useEffect(() => {
    const unsub = window.electronAPI.onOpenSettingsTab((next) => {
      setTab(next)
    })
    return unsub
  }, [])

  if (!isHydrated) {
    return (
      <div className="h-full bg-card text-muted-foreground flex flex-col">
        <SettingsTitleBar />
        <div className="flex-1 flex items-center justify-center text-sm">Loading…</div>
      </div>
    )
  }

  return (
    <div className="h-full flex flex-col bg-card text-foreground">
      <SettingsTitleBar />
      <div className="flex-1 flex overflow-hidden">
        <Sidebar current={tab} onChange={setTab} />
        <main className="flex-1 p-6 overflow-y-auto">
          {tab === 'general' && <GeneralPanel />}
          {tab === 'about' && <AboutPanel />}
          {tab.startsWith('module:') && (
            <ModulePanel moduleId={tab.slice(7)} />
          )}
        </main>
      </div>
    </div>
  )
}
