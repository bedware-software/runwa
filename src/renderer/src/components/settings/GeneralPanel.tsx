import { useEffect, useState } from 'react'
import {
  Button,
  ConfirmDialog,
  Label,
  Panel,
  PanelRow,
  PageHeader,
  SectionTitle,
  Segmented,
  Switch
} from '@bedware/ui'
import { Trash2 } from '@/lib/lucide-icons'
import { useSettingsStore } from '@/store/settings-store'
import {
  DEFAULT_SETTINGS,
  type AppInfo,
  type LightBackground,
  type Theme
} from '@shared/types'
import { cn } from '@/lib/utils'
import { settingsPageNumber } from './Sidebar'

const THEMES: Array<{ value: Theme; label: string }> = [
  { value: 'system', label: 'System' },
  { value: 'dark', label: 'Dark' },
  { value: 'light', label: 'Light' }
]

const LIGHT_BACKGROUNDS: Array<{ value: LightBackground; label: string }> = [
  { value: 'white', label: 'White' },
  { value: 'paper', label: 'Paper' },
  { value: 'soft', label: 'Paper soft' },
  { value: 'steel', label: 'Steel' },
  { value: 'stone', label: 'Stone' }
]

export function GeneralPanel() {
  const lightBackground = useSettingsStore(
    (s) => s.settings?.lightBackground ?? DEFAULT_SETTINGS.lightBackground
  )
  const setLightBackground = useSettingsStore((s) => s.setLightBackground)
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

  const modules = useSettingsStore((s) => s.modules)
  const [wipeConfirmOpen, setWipeConfirmOpen] = useState(false)

  const handleWipeAllData = (): void => {
    setWipeConfirmOpen(false)
    // Fire-and-forget — main process will relaunch the app immediately.
    void window.electronAPI.wipeAllData()
  }

  return (
    <div className="flex flex-col gap-4 max-w-xl">
      <PageHeader
        number={settingsPageNumber('general', modules)}
        title="General"
        description="How Runwa looks, how the palette behaves and how it starts with your system."
      />
      <div className="flex flex-col gap-8">
      <section>
        <SectionTitle
          title="Theme"
          description="Choose how runwa looks. System follows your OS preference."
        />
        <Segmented data-vim-item="general:theme"
          label="Theme"
          value={theme}
          options={THEMES}
          onChange={(value) => void setTheme(value)}
        />
        <div className="mt-4">
          <Label description="Background of the light theme: white, warm paper in two shades, cool steel or grey stone. Used whenever the theme on screen is light, also when System follows a light OS.">
            Light background
          </Label>
          <Segmented data-vim-item="general:light-background"
            label="Light background"
            value={lightBackground}
            options={LIGHT_BACKGROUNDS}
            onChange={(value) => void setLightBackground(value)}
          />
        </div>
      </section>

      <section>
        <SectionTitle
          title="Palette"
          description="Tweaks for the palette window's behaviour and shortcuts."
        />
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

      <section>
        <SectionTitle danger title="Danger Zone" />
        <Panel>
          <PanelRow
            title="Wipe all data"
            description="Permanently deletes the entire runwa application directory, including all settings, hotkeys, module configuration, keyboard remap rules, and caches. The app will relaunch as if freshly installed. This action cannot be undone."
          >
            <Button data-vim-item="general:wipe" data-vim-danger=""
              variant="danger"
              onClick={() => setWipeConfirmOpen(true)}
              icon={<Trash2 size={12} />}
              className="shrink-0"
            >
              Wipe all data
            </Button>
          </PanelRow>
        </Panel>
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
      <SectionTitle
        title="Startup"
        description="Automate how runwa comes up with your system."
      />
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
  return (
    <PanelRow
      title={title}
      description={description}
      tip={disabled ? disabledHint : undefined}
      className={cn(disabled && 'opacity-60')}
    >
      <Switch data-vim-item={`general:${title}`}
        checked={checked}
        onChange={onChange}
        label={title}
        disabled={disabled}
      />
    </PanelRow>
  )
}
