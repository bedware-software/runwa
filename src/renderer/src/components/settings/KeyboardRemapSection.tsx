import { useCallback, useEffect, useState } from 'react'
import { RefreshCw } from 'lucide-react'
import type { KeyboardRemapRulesView, KeyboardRemapTriggerView } from '@shared/types'
import { cn } from '@/lib/utils'
import { Hotkey } from '../ui/Kbd'
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
              <LabeledRow label="Tap">
                {t.onTap ? (
                  <Hotkey value={t.onTap} />
                ) : (
                  <span className="text-muted-foreground">—</span>
                )}
              </LabeledRow>
              <HoldBlock trigger={t} />
            </div>
          </div>
        ))}
      </div>
    </div>
  )
}

function LabeledRow({
  label,
  children
}: {
  label: string
  children: React.ReactNode
}) {
  return (
    <div className="flex items-center gap-2">
      <span className="text-muted-foreground w-10 shrink-0">{label}</span>
      <span className="text-muted-foreground">→</span>
      {children}
    </div>
  )
}

/**
 * `on_hold:` rendering follows the three shapes the YAML supports:
 *   - `transparent`: single modifier chip + "(transparent layer)" caption
 *   - `explicit`:    "Hold:" label, then a vertical list of combos
 *                    (including any `_default` row so the UI mirrors the
 *                    file 1:1 — no hidden "fallback X on macos" summary)
 *   - `passthrough`: literal "passthrough" caption
 */
function HoldBlock({ trigger }: { trigger: KeyboardRemapTriggerView }) {
  if (trigger.onHoldKind === 'transparent') {
    return (
      <LabeledRow label="Hold">
        {trigger.onHoldModifier && <Hotkey value={trigger.onHoldModifier} />}
        <span className="text-muted-foreground">(transparent layer)</span>
      </LabeledRow>
    )
  }

  if (trigger.onHoldKind === 'passthrough') {
    return (
      <LabeledRow label="Hold">
        <span className="text-muted-foreground">passthrough</span>
      </LabeledRow>
    )
  }

  // Explicit list — show the header plain (no "N rules" count / fallback
  // text) and the rules list below, matching the YAML shape.
  return (
    <>
      <div className="flex items-center gap-2">
        <span className="text-muted-foreground w-10 shrink-0">Hold</span>
        <span className="text-muted-foreground">→</span>
      </div>
      {trigger.combos && trigger.combos.length > 0 && (
        <div className="flex flex-col gap-1.5 pl-4 mt-1 border-l-2 border-border">
          {trigger.combos.map((c, i) => (
            <div key={`${c.trigger}-${i}`} className="flex flex-col gap-0.5">
              <div className="flex items-center gap-2 text-xs">
                <Hotkey value={c.trigger} />
                <span className="text-muted-foreground">→</span>
                <ActionDisplay result={c.result} />
                {c.os && (
                  <span className="text-[10px] uppercase tracking-wide text-muted-foreground">
                    {c.os}
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
    </>
  )
}

/**
 * Right-hand side of a rule: either a hotkey combo (chips) or an action
 * description like "→ Desktop 3" (plain text — not a keystroke, so
 * chipping it doesn't make sense).
 */
function ActionDisplay({ result }: { result: string }) {
  const isAction = result.startsWith('→')
  if (isAction) {
    return <span className="text-foreground">{result}</span>
  }
  return <Hotkey value={result} />
}
