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

  // Esc closes the window, as in Vimperium's Settings. Anything that has its
  // own use for Esc gets it first: the design system's dialogs and open
  // Select list and the hotkey recorder all stop the event, so it never
  // reaches this bubble-phase listener (the DOM checks are a second guard).
  // In a text field the first Esc only leaves the field — which commits its
  // draft — so a half-typed form isn't thrown away by one keypress.
  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent): void => {
      if (e.key !== 'Escape' || e.defaultPrevented || e.isComposing || e.repeat) return
      if (e.ctrlKey || e.metaKey || e.altKey || e.shiftKey) return
      if (
        document.querySelector(
          '[role="dialog"], [role="alertdialog"], [role="listbox"], [role="menu"]'
        )
      ) {
        return
      }
      const active = document.activeElement
      if (
        active instanceof HTMLElement &&
        (active instanceof HTMLTextAreaElement ||
          active.isContentEditable ||
          (active instanceof HTMLInputElement &&
            !['checkbox', 'radio', 'button', 'range', 'color'].includes(active.type)))
      ) {
        e.preventDefault()
        active.blur()
        return
      }
      e.preventDefault()
      window.close()
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
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
