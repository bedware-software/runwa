import { useEffect, useState } from 'react'
import { useSettingsStore } from '@/store/settings-store'
import { Sidebar, type SettingsTab } from './Sidebar'
import { SettingsTitleBar } from './SettingsTitleBar'
import { GeneralPanel } from './GeneralPanel'
import { ModulesPanel } from './ModulesPanel'

export function SettingsApp() {
  const [tab, setTab] = useState<SettingsTab>('general')
  const hydrate = useSettingsStore((s) => s.hydrate)
  const applyServerSettings = useSettingsStore((s) => s.applyServerSettings)
  const theme = useSettingsStore((s) => s.settings?.theme ?? 'dark')
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

  if (!isHydrated) {
    return (
      <div className="h-full bg-background text-muted-foreground flex flex-col">
        <SettingsTitleBar />
        <div className="flex-1 flex items-center justify-center text-sm">Loading…</div>
      </div>
    )
  }

  return (
    <div className="h-full flex flex-col bg-background text-foreground">
      <SettingsTitleBar />
      <div className="flex-1 flex overflow-hidden">
        <Sidebar current={tab} onChange={setTab} />
        <main className="flex-1 p-6 overflow-y-auto">
          {tab === 'general' && <GeneralPanel />}
          {tab === 'modules' && <ModulesPanel />}
        </main>
      </div>
    </div>
  )
}
