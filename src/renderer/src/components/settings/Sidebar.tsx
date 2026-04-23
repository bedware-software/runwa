import { Info, SlidersHorizontal } from 'lucide-react'
import * as Icons from 'lucide-react'
import type { LucideIcon } from 'lucide-react'
import { cn } from '@/lib/utils'
import { useSettingsStore } from '@/store/settings-store'
import type { ModuleMeta, SettingsTabId } from '@shared/types'

export type SettingsTab = SettingsTabId

interface Props {
  current: SettingsTab
  onChange: (tab: SettingsTab) => void
}

function iconFromHint(hint: string | undefined): LucideIcon {
  if (!hint) return Icons.Package
  const name = hint
    .split('-')
    .map((s) => (s[0] ?? '').toUpperCase() + s.slice(1))
    .join('')
  const lookup = Icons as unknown as Record<string, LucideIcon>
  return lookup[name] ?? Icons.Package
}

export function Sidebar({ current, onChange }: Props) {
  const modules = useSettingsStore((s) => s.modules)
  const setEnabled = useSettingsStore((s) => s.setModuleEnabled)

  return (
    <aside className="w-56 bg-card border-r border-border p-3 flex flex-col shrink-0">
      <nav className="flex flex-col gap-1">
        <button
          type="button"
          onClick={() => onChange('general')}
          className={cn(
            'flex items-center gap-2 h-8 px-2 rounded-md text-sm text-left transition-colors',
            current === 'general'
              ? 'bg-accent text-accent-foreground'
              : 'text-muted-foreground hover:bg-accent/50 hover:text-foreground'
          )}
        >
          <SlidersHorizontal size={16} />
          General
        </button>
      </nav>

      {modules.length > 0 && (
        <div className="border-t border-border mt-3 pt-3 flex flex-col gap-3">
          {/*
            Two-level grouping: "Searches" are modules that appear in the
            home-screen picker (App Search, Window Switcher, future
            Files/Calculator/…). "Other" is background services and
            hotkey-only utilities that never show up in the palette list
            (Keyboard Remap, Groq Transcription). Preserving registration
            order within each group means adding a new module keeps its
            position predictable.
          */}
          <ModuleGroup
            label="Searches"
            modules={modules.filter((m) => m.kind === 'search')}
            current={current}
            onChange={onChange}
            onToggle={(id, v) => void setEnabled(id, v)}
          />
          <ModuleGroup
            label="Other"
            modules={modules.filter((m) => m.kind !== 'search')}
            current={current}
            onChange={onChange}
            onToggle={(id, v) => void setEnabled(id, v)}
          />
        </div>
      )}

      <nav className="mt-auto pt-3 border-t border-border flex flex-col gap-1">
        <button
          type="button"
          onClick={() => onChange('about')}
          className={cn(
            'flex items-center gap-2 h-8 px-2 rounded-md text-sm text-left transition-colors',
            current === 'about'
              ? 'bg-accent text-accent-foreground'
              : 'text-muted-foreground hover:bg-accent/50 hover:text-foreground'
          )}
        >
          <Info size={16} />
          About
        </button>
      </nav>
    </aside>
  )
}

interface ModuleGroupProps {
  label: string
  modules: ModuleMeta[]
  current: SettingsTab
  onChange: (tab: SettingsTab) => void
  onToggle: (moduleId: string, enabled: boolean) => void
}

function ModuleGroup({ label, modules, current, onChange, onToggle }: ModuleGroupProps) {
  if (modules.length === 0) return null
  return (
    <div>
      <div className="text-[11px] font-medium text-muted-foreground/70 uppercase tracking-wider px-2 mb-2">
        {label}
      </div>
      <div className="flex flex-col gap-0.5">
        {modules.map((m) => {
          const Icon = iconFromHint(m.icon)
          const active = current === `module:${m.id}`
          return (
            <button
              key={m.id}
              type="button"
              onClick={() => onChange(`module:${m.id}`)}
              className={cn(
                'flex items-center gap-2 h-8 px-2 rounded-md transition-colors',
                active
                  ? 'bg-accent text-accent-foreground'
                  : 'hover:bg-accent/50'
              )}
            >
              <Icon
                size={14}
                className={cn(
                  'shrink-0 transition-colors',
                  active
                    ? 'text-accent-foreground'
                    : m.enabled
                      ? 'text-muted-foreground'
                      : 'text-muted-foreground/40'
                )}
              />
              <span
                className={cn(
                  'flex-1 text-left text-sm truncate transition-colors',
                  active
                    ? 'text-accent-foreground'
                    : m.enabled
                      ? 'text-muted-foreground'
                      : 'text-muted-foreground/40'
                )}
              >
                {m.name}
              </span>
              <SidebarToggle
                checked={m.enabled}
                onChange={(v) => onToggle(m.id, v)}
              />
            </button>
          )
        })}
      </div>
    </div>
  )
}

function SidebarToggle({
  checked,
  onChange
}: {
  checked: boolean
  onChange: (v: boolean) => void
}) {
  return (
    <button
      type="button"
      onClick={(e) => {
        e.stopPropagation()
        onChange(!checked)
      }}
      className={cn(
        'w-7 h-4 rounded-full transition-colors relative shrink-0',
        checked ? 'bg-primary' : 'bg-muted'
      )}
      aria-pressed={checked}
    >
      <div
        className={cn(
          'w-3 h-3 rounded-full bg-background absolute top-0.5 transition-transform',
          checked ? 'translate-x-[14px]' : 'translate-x-0.5'
        )}
      />
    </button>
  )
}
