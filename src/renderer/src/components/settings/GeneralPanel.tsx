import { useState } from 'react'
import { AlertTriangle, Trash2 } from 'lucide-react'
import { useSettingsStore } from '@/store/settings-store'
import { DEFAULT_SETTINGS, type Theme } from '@shared/types'
import { cn } from '@/lib/utils'
import { HotkeyRow } from './HotkeyRow'
import { ConfirmDialog } from '../ConfirmDialog'

const THEMES: Array<{ value: Theme; label: string }> = [
  { value: 'system', label: 'System' },
  { value: 'dark', label: 'Dark' },
  { value: 'light', label: 'Light' }
]

export function GeneralPanel() {
  const theme = useSettingsStore((s) => s.settings?.theme ?? 'system')
  const setTheme = useSettingsStore((s) => s.setTheme)
  const activationHotkey = useSettingsStore(
    (s) => s.settings?.activationHotkey ?? ''
  )
  const setActivationHotkey = useSettingsStore((s) => s.setActivationHotkey)
  const openSettingsHotkey = useSettingsStore(
    (s) => s.settings?.openSettingsHotkey ?? ''
  )
  const setOpenSettingsHotkey = useSettingsStore(
    (s) => s.setOpenSettingsHotkey
  )

  const [wipeConfirmOpen, setWipeConfirmOpen] = useState(false)

  const handleWipeAllData = (): void => {
    setWipeConfirmOpen(false)
    // Fire-and-forget — main process will relaunch the app immediately.
    void window.electronAPI.wipeAllData()
  }

  return (
    <div className="flex flex-col gap-8 max-w-xl">
      <section>
        <h2 className="text-sm font-semibold text-foreground mb-1">Theme</h2>
        <p className="text-xs text-muted-foreground mb-3">
          Choose how runwa looks. System follows your OS preference.
        </p>
        <div className="flex gap-2">
          {THEMES.map((t) => (
            <button
              key={t.value}
              type="button"
              onClick={() => void setTheme(t.value)}
              className={cn(
                'h-8 px-3 rounded-md text-xs font-medium border transition-colors',
                theme === t.value
                  ? 'bg-primary text-primary-foreground border-primary'
                  : 'bg-secondary text-secondary-foreground border-input hover:bg-accent'
              )}
            >
              {t.label}
            </button>
          ))}
        </div>
      </section>

      <section>
        <h2 className="text-sm font-semibold text-foreground mb-1">Hotkeys</h2>
        <p className="text-xs text-muted-foreground mb-3">
          Keyboard shortcuts for opening runwa and its settings.
        </p>
        <div className="flex flex-col divide-y divide-border border border-input rounded-md bg-card overflow-hidden">
          <HotkeyRow
            title="Open runwa"
            scope="Global"
            description="Toggles the command palette from anywhere."
            value={activationHotkey}
            defaultValue={DEFAULT_SETTINGS.activationHotkey}
            onChange={(v) => void setActivationHotkey(v)}
          />
          <HotkeyRow
            title="Open Settings"
            scope="Window-local"
            description="Only works when a runwa window is focused."
            value={openSettingsHotkey}
            defaultValue={DEFAULT_SETTINGS.openSettingsHotkey}
            onChange={(v) => void setOpenSettingsHotkey(v)}
          />
        </div>
      </section>

      <section className="pt-4 border-t border-destructive/30">
        <div className="flex items-center gap-2 mb-3">
          <AlertTriangle size={14} className="text-destructive" />
          <h2 className="text-sm font-semibold text-destructive">
            Danger Zone
          </h2>
        </div>
        <div className="rounded-lg border border-destructive/40 bg-destructive/5 p-4 flex items-start gap-4">
          <div className="flex-1 min-w-0">
            <p className="text-sm font-medium text-foreground">
              Wipe all data
            </p>
            <p className="text-[11px] text-muted-foreground mt-1 leading-relaxed">
              Permanently deletes the entire runwa application directory,
              including all settings, hotkeys, module configuration, keyboard
              remap rules, and caches. The app will relaunch as if freshly
              installed. This action cannot be undone.
            </p>
          </div>
          <button
            type="button"
            onClick={() => setWipeConfirmOpen(true)}
            className="shrink-0 flex items-center gap-1.5 h-8 px-3 rounded-md text-xs font-medium bg-destructive text-destructive-foreground hover:opacity-90"
          >
            <Trash2 size={12} />
            Wipe all data
          </button>
        </div>
      </section>

      <ConfirmDialog
        open={wipeConfirmOpen}
        title="Wipe all runwa data?"
        message="This will permanently delete every setting, hotkey, module configuration, keyboard remap rule, and cache, then relaunch the app. This cannot be undone."
        confirmLabel="Wipe everything"
        destructive
        onConfirm={handleWipeAllData}
        onCancel={() => setWipeConfirmOpen(false)}
      />
    </div>
  )
}
