import { useEffect, useState } from 'react'
import { Button, ConfirmDialog, Panel, Segmented, Switch } from '@bedware/ui'
import { AlertTriangle, Trash2 } from '@/lib/lucide-icons'
import { useSettingsStore } from '@/store/settings-store'
import { DEFAULT_SETTINGS, type AppInfo, type Theme } from '@shared/types'
import { cn } from '@/lib/utils'

const THEMES: Array<{ value: Theme; label: string }> = [
  { value: 'system', label: 'System' },
  { value: 'dark', label: 'Dark' },
  { value: 'light', label: 'Light' }
]

export function GeneralPanel() {
  const theme = useSettingsStore((s) => s.settings?.theme ?? 'system')
  const setTheme = useSettingsStore((s) => s.setTheme)
  const quickLaunchDigitsRequireAlt = useSettingsStore(
    (s) =>
      s.settings?.quickLaunchDigitsRequireAlt ??
      DEFAULT_SETTINGS.quickLaunchDigitsRequireAlt
  )
  const setQuickLaunchDigitsRequireAlt = useSettingsStore(
    (s) => s.setQuickLaunchDigitsRequireAlt
  )
  const paletteSwitchToEnglish = useSettingsStore(
    (s) =>
      s.settings?.paletteSwitchToEnglish ?? DEFAULT_SETTINGS.paletteSwitchToEnglish
  )
  const setPaletteSwitchToEnglish = useSettingsStore(
    (s) => s.setPaletteSwitchToEnglish
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
        <Segmented
          label="Theme"
          value={theme}
          options={THEMES}
          onChange={(value) => void setTheme(value)}
        />
      </section>

      <section>
        <h2 className="text-sm font-semibold text-foreground mb-1">Palette</h2>
        <p className="text-xs text-muted-foreground mb-3">
          Tweaks for the palette window's behaviour and shortcuts.
        </p>
        <Panel>
          <ToggleRow
            title="Use Alt + number to run a result"
            description="The first nine results are always labelled 1–9. By default a plain digit runs that result and Alt+digit types the digit into the search box. Turn this on to swap them: Alt+digit runs the result and plain digits type as normal."
            checked={quickLaunchDigitsRequireAlt}
            onChange={(v) => void setQuickLaunchDigitsRequireAlt(v)}
          />
          <ToggleRow
            title="Switch to English on any search dialog open"
            description="Whenever a search dialog opens, force the system input language to English so you can type the query without switching layouts first. The English keyboard must already be installed as a system input source."
            checked={paletteSwitchToEnglish}
            onChange={(v) => void setPaletteSwitchToEnglish(v)}
          />
        </Panel>
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
          <Button
            variant="danger"
            onClick={() => setWipeConfirmOpen(true)}
            icon={<Trash2 size={12} />}
            className="shrink-0"
          >
            Wipe all data
          </Button>
        </div>
      </section>

      <ConfirmDialog
        open={wipeConfirmOpen}
        title="Wipe all runwa data?"
        message="This will permanently delete every setting, hotkey, module configuration, keyboard remap rule, and cache, then relaunch the app. This cannot be undone."
        confirmLabel="Wipe everything"
        initialFocus="cancel"
        onConfirm={handleWipeAllData}
        onCancel={() => setWipeConfirmOpen(false)}
      />
    </div>
  )
}

/**
 * OS-integration toggles — "Start at login" and Windows-only "Run as
 * administrator". The main-process `startup-integration` module maps the
 * two toggles onto three OS mechanisms (HKCU Run key, RUNASADMIN
 * AppCompat flag, and — for the both-on case — an elevated logon
 * scheduled task), because on Windows a plain Run-key autostart can't
 * launch an elevated process.
 *
 * Disabled in dev (`app.isPackaged === false`) because writing the
 * real registry / LoginItem / task entries would point at
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
      <Panel>
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
            description="Run runwa elevated. Needed for global hotkeys / keyboard remap to work inside other elevated apps (Task Manager, elevated terminals). Manual launches show a UAC prompt; combined with “Start at login” it registers a scheduled task so it starts elevated at login with no prompt (flipping the toggle asks for admin once)."
            checked={runAsAdmin}
            disabled={devMode}
            disabledHint={devMode ? devHint : undefined}
            onChange={(v) => void setRunAsAdmin(v)}
          />
        )}
      </Panel>
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
  // The design system's panel row, written out by class: PanelRow takes
  // `title` as its heading, and this row needs the native tooltip.
  return (
    <div
      className={cn('bw-row', disabled && 'opacity-60')}
      title={disabled ? disabledHint : undefined}
    >
      <div className="flex-1 min-w-0">
        <span className="bw-row__title">{title}</span>
        <span className="bw-row__desc">{description}</span>
      </div>
      <Switch
        checked={checked}
        onChange={onChange}
        label={title}
        disabled={disabled}
      />
    </div>
  )
}
