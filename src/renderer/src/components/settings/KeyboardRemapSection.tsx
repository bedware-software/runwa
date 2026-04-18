import { useCallback, useEffect, useState } from 'react'
import { RefreshCw } from 'lucide-react'
import type { KeyboardRemapRulesView } from '@shared/types'
import { cn } from '@/lib/utils'
import { PermissionSection } from './PermissionSection'

/**
 * Dedicated settings section for the keyboard-remap module. Renders the
 * rules file path (read-only), an Edit button that opens the YAML in the
 * system editor, a Reload button that re-installs the hook from disk, and
 * a read-only list of the currently parsed hotkeys.
 *
 * Kept out of the generic `ConfigField` pipeline because the list shape
 * (per-trigger tap/hold with nested combos) doesn't fit any of the
 * `ModuleConfigField` variants.
 */
export function KeyboardRemapSection() {
  const [view, setView] = useState<KeyboardRemapRulesView | null>(null)
  const [reloading, setReloading] = useState(false)

  useEffect(() => {
    let cancelled = false
    void window.electronAPI.keyboardRemapGetRules().then((v) => {
      if (!cancelled) setView(v)
    })
    return () => {
      cancelled = true
    }
  }, [])

  const onEdit = useCallback(() => {
    void window.electronAPI.modulesAction('keyboard-remap', 'openRules')
  }, [])

  const onReload = useCallback(async () => {
    setReloading(true)
    try {
      const next = await window.electronAPI.keyboardRemapReload()
      setView(next)
    } finally {
      setReloading(false)
    }
  }, [])

  return (
    <div className="pt-3 border-t border-border flex flex-col gap-4">
      <div className="flex flex-col gap-2">
        <div className="text-xs font-medium text-foreground">Rules file</div>
        <div className="text-xs text-muted-foreground -mt-1">
          YAML config for tap/hold bindings. Click Edit to open in your system
          editor; Reload re-installs the hook from disk — no app restart.
        </div>
        <div className="flex items-center gap-2">
          <input
            type="text"
            readOnly
            value={view?.filePath ?? ''}
            onFocus={(e) => e.currentTarget.select()}
            className="h-8 flex-1 px-3 rounded-md bg-card border border-input text-xs text-foreground outline-none font-mono truncate"
          />
          <button
            type="button"
            onClick={onEdit}
            className={cn(
              'h-8 px-3 rounded-md text-xs font-medium border shrink-0 transition-colors',
              'bg-secondary text-secondary-foreground border-input hover:bg-accent'
            )}
          >
            Edit
          </button>
          <button
            type="button"
            onClick={() => void onReload()}
            disabled={reloading}
            className={cn(
              'h-8 px-3 rounded-md text-xs font-medium border shrink-0 transition-colors flex items-center gap-1.5',
              'bg-secondary text-secondary-foreground border-input hover:bg-accent',
              reloading && 'opacity-60 cursor-not-allowed'
            )}
          >
            <RefreshCw size={12} className={cn(reloading && 'animate-spin')} />
            Reload
          </button>
        </div>
      </div>

      <RulesList view={view} />

      <PermissionSection
        heading="Permissions"
        description="macOS Accessibility access is needed to install the low-level keyboard hook. Relaunch runwa after granting."
        rows={[
          {
            name: 'accessibility',
            title: 'Accessibility',
            description:
              'Lets runwa intercept and synthesize key events for CapsLock / Space-layer rebinds.'
          }
        ]}
      />
    </div>
  )
}

function RulesList({ view }: { view: KeyboardRemapRulesView | null }) {
  if (!view) {
    return (
      <div className="text-xs text-muted-foreground">Loading rules…</div>
    )
  }

  if (view.error) {
    return (
      <div className="flex flex-col gap-2">
        <div className="text-xs font-medium text-foreground">Hotkeys</div>
        <div className="px-3 py-2 rounded-md bg-destructive/10 border border-destructive/40 text-xs text-destructive font-mono">
          {view.error}
        </div>
      </div>
    )
  }

  if (view.triggers.length === 0) {
    return (
      <div className="flex flex-col gap-2">
        <div className="text-xs font-medium text-foreground">Hotkeys</div>
        <div className="text-xs text-muted-foreground">
          No triggers defined. Edit the file to add bindings.
        </div>
      </div>
    )
  }

  return (
    <div className="flex flex-col gap-2">
      <div className="text-xs font-medium text-foreground">Hotkeys</div>
      <div className="flex flex-col divide-y divide-border border border-input rounded-md bg-card overflow-hidden">
        {view.triggers.map((t) => (
          <div key={t.name} className="flex flex-col gap-2 px-4 py-3">
            <div className="text-xs font-semibold text-foreground">{t.name}</div>
            <div className="flex flex-col gap-1 text-xs">
              <RuleLine label="Tap" value={t.onTap ?? '—'} />
              <RuleLine label="Hold" value={t.onHoldSummary} />
            </div>
            {t.combos && t.combos.length > 0 && (
              <div className="flex flex-col gap-1.5 pl-4 mt-1 border-l-2 border-border">
                {t.combos.map((c, i) => (
                  <div key={`${c.trigger}-${i}`} className="flex flex-col gap-0.5">
                    <div className="flex items-baseline gap-2 text-xs">
                      <Kbd>{c.trigger}</Kbd>
                      <span className="text-muted-foreground">→</span>
                      <Kbd>{c.result}</Kbd>
                      {c.platform && (
                        <span className="text-[10px] uppercase tracking-wide text-muted-foreground">
                          {c.platform}
                        </span>
                      )}
                    </div>
                    {c.description && (
                      <div className="text-[11px] text-muted-foreground">
                        {c.description}
                      </div>
                    )}
                  </div>
                ))}
              </div>
            )}
          </div>
        ))}
      </div>
    </div>
  )
}

function RuleLine({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-baseline gap-2">
      <span className="text-muted-foreground w-10 shrink-0">{label}</span>
      <span className="text-muted-foreground">→</span>
      <span className="text-foreground">{value}</span>
    </div>
  )
}

function Kbd({ children }: { children: React.ReactNode }) {
  return (
    <code className="bg-secondary text-foreground font-mono px-1.5 py-0.5 rounded text-[11px]">
      {children}
    </code>
  )
}
