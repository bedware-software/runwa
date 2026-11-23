import { useCallback, useEffect, useState } from 'react'
import { Button, InputField, Panel, PanelRow, Select } from '@bedware/ui'
import type { UlanziProfileSummary } from '@shared/types'
import {
  ULANZI_ID,
  ULANZI_PROFILES_KEY,
  readUlanziProfileRules,
  resolveUlanziDisplay,
  serializeUlanziProfileRules,
  ulanziProfileRule,
  type UlanziProfileDisplay,
  type UlanziProfileRule,
  type UlanziProfileRules
} from '@shared/ulanzi'
import { RefreshCw, Trash2 } from '@/lib/lucide-icons'
import { cn } from '@/lib/utils'
import { useSettingsStore } from '@/store/settings-store'

const DISPLAY_LABELS: Record<Exclude<UlanziProfileDisplay, 'auto'>, string> = {
  brief: 'Brief',
  sticky: 'Sticky',
  hidden: 'Hidden'
}

interface Row {
  name: string
  /** Null when the profile is only known from a saved override. */
  profile: UlanziProfileSummary | null
}

function readableError(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error)
  return message.replace(/^Error invoking remote method '[^']+': Error: /, '') ||
    'Something went wrong. Please try again.'
}

function describeApp(profile: UlanziProfileSummary | null): string {
  if (!profile) return 'Not found in Ulanzi Studio'
  if (profile.app === null) return 'Mode — follows no app'
  if (profile.app === 'default') return 'Default for other apps'
  const base = profile.app.split(/[\\/]/).pop() ?? profile.app
  return `Follows ${base.replace(/\.app$/i, '')}`
}

/**
 * Per-profile table for the Ulanzi module. The profiles come from Ulanzi
 * Studio's own manifests (over IPC), so the user never types a name; the
 * overrides they set are stored as one JSON value in the module config.
 */
export function UlanziSection() {
  const storedConfig = useSettingsStore((s) => s.settings?.modules[ULANZI_ID]?.config)
  const setConfig = useSettingsStore((s) => s.setModuleConfig)
  const rules = readUlanziProfileRules(storedConfig)

  const [installed, setInstalled] = useState(true)
  const [profiles, setProfiles] = useState<UlanziProfileSummary[] | null>(null)
  const [loadError, setLoadError] = useState<string | null>(null)

  const load = useCallback(async (): Promise<void> => {
    setLoadError(null)
    try {
      const view = await window.electronAPI.ulanziListProfiles()
      setInstalled(view.installed)
      setProfiles(view.profiles)
    } catch (err) {
      setLoadError(readableError(err))
    }
  }, [])

  useEffect(() => {
    void load()
  }, [load])

  const saveRules = (next: UlanziProfileRules): void => {
    void setConfig(ULANZI_ID, {
      [ULANZI_PROFILES_KEY]: serializeUlanziProfileRules(next)
    })
  }

  const patchRule = (name: string, patch: Partial<UlanziProfileRule>): void => {
    saveRules({ ...rules, [name]: { ...ulanziProfileRule(rules, name), ...patch } })
  }

  const removeRule = (name: string): void => {
    const next = { ...rules }
    delete next[name]
    saveRules(next)
  }

  const known = new Set((profiles ?? []).map((p) => p.name))
  const rows: Row[] = [
    ...(profiles ?? []).map((profile) => ({ name: profile.name, profile })),
    ...Object.keys(rules)
      .filter((name) => profiles !== null && !known.has(name))
      .sort()
      .map((name) => ({ name, profile: null }))
  ]

  return (
    <div className="flex flex-col gap-2">
      <div className="flex items-center justify-between gap-3">
        <div className="text-xs font-semibold uppercase tracking-wider text-foreground">
          Profiles
        </div>
        <Button
          variant="ghost"
          onClick={() => void load()}
          title="Read the profile list from Ulanzi Studio again"
          icon={<RefreshCw size={12} />}
        >
          Refresh
        </Button>
      </div>
      <p className="m-0 text-xs leading-relaxed text-muted-foreground">
        <span className="text-foreground">Brief</span> hints disappear after a
        moment. <span className="text-foreground">Sticky</span> ones stay on
        screen until another profile becomes active — meant for modes you
        toggle from the device. <span className="text-foreground">Auto</span>{' '}
        makes profiles that follow no app sticky and the rest brief. The label
        replaces the profile name in the hint.
      </p>

      <Panel>
        {loadError ? (
          <PanelRow role="alert" className="py-4 gap-3 text-xs text-destructive">
            <span>{loadError}</span>
            <Button onClick={() => void load()} className="shrink-0">
              Retry
            </Button>
          </PanelRow>
        ) : profiles === null ? (
          <PanelRow className="py-5 text-xs text-muted-foreground">
            Loading profiles…
          </PanelRow>
        ) : !installed ? (
          <PanelRow className="py-5 text-xs text-muted-foreground">
            Ulanzi Studio isn’t installed for this user. Hints start working
            once it is.
          </PanelRow>
        ) : rows.length === 0 ? (
          <PanelRow className="py-5 text-xs text-muted-foreground">
            Ulanzi Studio has no profiles yet.
          </PanelRow>
        ) : (
          rows.map((row) => (
            <ProfileRow
              key={row.name}
              row={row}
              rule={ulanziProfileRule(rules, row.name)}
              onPatch={(patch) => patchRule(row.name, patch)}
              onRemove={() => removeRule(row.name)}
            />
          ))
        )}
      </Panel>
    </div>
  )
}

interface ProfileRowProps {
  row: Row
  rule: UlanziProfileRule
  onPatch: (patch: Partial<UlanziProfileRule>) => void
  onRemove: () => void
}

function ProfileRow({ row, rule, onPatch, onRemove }: ProfileRowProps) {
  const [label, setLabel] = useState(rule.label)
  // Adopt saved values (another window, a reset) without fighting typing:
  // the draft only commits on blur / Enter.
  useEffect(() => {
    setLabel(rule.label)
  }, [rule.label])

  const commitLabel = (): void => {
    const next = label.trim()
    setLabel(next)
    if (next !== rule.label) onPatch({ label: next })
  }

  const autoResolved = resolveUlanziDisplay(
    { label: '', display: 'auto' },
    row.profile ?? undefined
  )

  return (
    <PanelRow className="gap-3 py-2.5">
      <div className="flex-1 min-w-0">
        <div className="text-sm font-medium text-foreground truncate">{row.name}</div>
        <div
          className={cn(
            'text-xs truncate',
            row.profile ? 'text-muted-foreground' : 'text-destructive'
          )}
        >
          {describeApp(row.profile)}
        </div>
      </div>
      <InputField
        type="text"
        size="sm"
        value={label}
        placeholder={row.name}
        onChange={(event) => setLabel(event.target.value)}
        onBlur={commitLabel}
        onKeyDown={(event) => {
          if (event.key === 'Enter') event.currentTarget.blur()
        }}
        aria-label={`Hint label for ${row.name}`}
        spellCheck={false}
        autoComplete="off"
        boxClassName="w-40"
      />
      <Select<UlanziProfileDisplay>
        value={rule.display}
        onChange={(display) => onPatch({ display })}
        label={`Hint behaviour for ${row.name}`}
        options={[
          { value: 'auto', label: `Auto (${DISPLAY_LABELS[autoResolved].toLowerCase()})` },
          { value: 'brief', label: DISPLAY_LABELS.brief },
          { value: 'sticky', label: DISPLAY_LABELS.sticky },
          { value: 'hidden', label: DISPLAY_LABELS.hidden }
        ]}
        className="w-36 shrink-0"
      />
      {!row.profile && (
        <button
          type="button"
          onClick={onRemove}
          aria-label={`Forget settings for ${row.name}`}
          title="Forget these settings"
          className="h-7 w-7 rounded-md flex items-center justify-center shrink-0 text-muted-foreground hover:bg-destructive/10 hover:text-destructive"
        >
          <Trash2 size={14} />
        </button>
      )}
    </PanelRow>
  )
}
