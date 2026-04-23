import { useEffect, useState } from 'react'
import { AlertTriangle, Trash2 } from 'lucide-react'
import { useSettingsStore } from '@/store/settings-store'
import { DEFAULT_SETTINGS, type AppInfo, type Theme } from '@shared/types'
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

      <StartupSection />

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

/**
 * OS-integration toggles — "Start at login" and Windows-only "Run as
 * administrator". Both are registered in user-scope OS state (HKCU or
 * macOS LoginItems) by the main-process `startup-integration` module
 * on every settings change.
 *
 * Disabled in dev (`app.isPackaged === false`) because writing the
 * real registry / LoginItem entries would point at
 * `node_modules/electron/dist/electron.exe`, which isn't what the user
 * actually wants auto-started or elevated. The tooltip on each row
 * explains why.
 */
function StartupSection() {
  const startAtLogin = useSettingsStore(
    (s) => s.settings?.startAtLogin ?? DEFAULT_SETTINGS.startAtLogin
  )
  const runAsAdmin = useSettingsStore(
    (s) => s.settings?.runAsAdmin ?? DEFAULT_SETTINGS.runAsAdmin
  )
  const setStartAtLogin = useSettingsStore((s) => s.setStartAtLogin)
  const setRunAsAdmin = useSettingsStore((s) => s.setRunAsAdmin)

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

  const devMode = info ? !info.isPackaged : false
  const isWindows = info?.platform === 'win32'
  const devHint = 'Only takes effect in packaged installs.'

  return (
    <section>
      <h2 className="text-sm font-semibold text-foreground mb-1">Startup</h2>
      <p className="text-xs text-muted-foreground mb-3">
        Automate how runwa comes up with your system.
      </p>
      <div className="flex flex-col divide-y divide-border border border-input rounded-md bg-card overflow-hidden">
        <ToggleRow
          title="Start at login"
          description="Launch runwa automatically when you sign in. Starts hidden in the tray."
          checked={startAtLogin}
          disabled={devMode}
          disabledHint={devMode ? devHint : undefined}
          onChange={(v) => void setStartAtLogin(v)}
        />
        {isWindows && (
          <ToggleRow
            title="Run as administrator"
            description="Relaunch runwa elevated on every start. Needed for global hotkeys / keyboard remap to work inside other elevated apps (Task Manager, elevated terminals). Triggers a UAC prompt each launch."
            checked={runAsAdmin}
            disabled={devMode}
            disabledHint={devMode ? devHint : undefined}
            onChange={(v) => void setRunAsAdmin(v)}
          />
        )}
      </div>
    </section>
  )
}

interface ToggleRowProps {
  title: string
  description: string
  checked: boolean
  disabled?: boolean
  disabledHint?: string
  onChange: (v: boolean) => void
}

function ToggleRow({
  title,
  description,
  checked,
  disabled,
  disabledHint,
  onChange
}: ToggleRowProps) {
  return (
    <div
      className={cn(
        'flex items-center justify-between gap-4 px-4 py-3',
        disabled && 'opacity-60'
      )}
      title={disabled ? disabledHint : undefined}
    >
      <div className="flex-1 min-w-0">
        <div className="text-sm font-medium text-foreground">{title}</div>
        <div className="text-xs text-muted-foreground mt-0.5">{description}</div>
      </div>
      <button
        type="button"
        onClick={() => {
          if (disabled) return
          onChange(!checked)
        }}
        disabled={disabled}
        className={cn(
          'w-10 h-6 rounded-full transition-colors relative shrink-0',
          checked ? 'bg-primary' : 'bg-muted',
          disabled && 'cursor-not-allowed'
        )}
        aria-pressed={checked}
      >
        <div
          className={cn(
            'w-5 h-5 rounded-full bg-background absolute top-0.5 transition-transform',
            checked ? 'translate-x-[18px]' : 'translate-x-0.5'
          )}
        />
      </button>
    </div>
  )
}
