import { Nav, NavGroup, NavItem, Switch } from '@bedware/ui'
import type { LucideIcon } from '@/lib/lucide-icons'
import {
  Info,
  lucideIconFromHint,
  Package,
  SlidersHorizontal
} from '@/lib/lucide-icons'
import { useSettingsStore } from '@/store/settings-store'
import type { ModuleMeta, SettingsTabId } from '@shared/types'

export type SettingsTab = SettingsTabId

/**
 * Module ids that land under the "Keyboard" subheader. Kept as a
 * Sidebar-local list so modules don't have to know about their own
 * settings grouping — the sidebar is the only place that renders these
 * sections today.
 */
const KEYBOARD_MODULE_IDS = new Set(['keyboard-remap', 'hotstrings'])

/**
 * Search-kind modules that should still render under "Other" in the
 * sidebar. Flashcards is a `kind: 'search'` module (it does open the
 * palette like a search), but conceptually it's an in-app tool rather
 * than a system launcher, so it groups better with non-launcher
 * modules. The runtime kind is unchanged — only the sidebar bucket
 * shifts.
 */
const OTHER_OVERRIDE_IDS = new Set(['flashcards'])

const isSearchGroup = (m: ModuleMeta): boolean =>
  m.kind === 'search' && !OTHER_OVERRIDE_IDS.has(m.id)
const isKeyboardGroup = (m: ModuleMeta): boolean =>
  m.kind !== 'search' && KEYBOARD_MODULE_IDS.has(m.id)

/**
 * Every tab in the order the sidebar lists them, top to bottom — what the
 * Vim keys' next / previous section walk through.
 */
export function settingsTabOrder(modules: ModuleMeta[]): SettingsTab[] {
  const tab = (m: ModuleMeta): SettingsTab => `module:${m.id}`
  return [
    'general',
    ...modules.filter(isSearchGroup).map(tab),
    ...modules.filter(isKeyboardGroup).map(tab),
    ...modules.filter((m) => !isSearchGroup(m) && !isKeyboardGroup(m)).map(tab),
    'about'
  ]
}

/**
 * A page's place in the sidebar as two digits ("01", "02", …) — the number on
 * its PageHeader. Counted from the same list the sidebar is drawn from.
 */
export function settingsPageNumber(tab: SettingsTab, modules: ModuleMeta[]): string {
  const at = settingsTabOrder(modules).indexOf(tab)
  return String(at + 1).padStart(2, '0')
}

interface Props {
  current: SettingsTab
  onChange: (tab: SettingsTab) => void
}

function iconFromHint(hint: string | undefined): LucideIcon {
  return lucideIconFromHint(hint, Package)
}

export function Sidebar({ current, onChange }: Props) {
  const modules = useSettingsStore((s) => s.modules)
  const setEnabled = useSettingsStore((s) => s.setModuleEnabled)

  return (
    <aside className="w-56 bg-card border-r border-border p-3 flex flex-col shrink-0">
      <Nav>
        <NavItem data-vim-item="nav:general" data-vim-nowalk=""
          icon={<SlidersHorizontal size={16} />}
          current={current === 'general'}
          onClick={() => onChange('general')}
        >
          General
        </NavItem>
      </Nav>

      {modules.length > 0 && (
        <div className="border-t border-border mt-3 pt-3 pr-1 -mr-1 flex-1 min-h-0 overflow-y-auto flex flex-col gap-3">
          {/*
            Three-level grouping: "Searches" are modules that appear in
            the home-screen picker (App Search, Window Switcher, future
            Files/Calculator/…). "Keyboard" groups the low-level input
            services (Keyboard Remap, Hotstrings) so users looking for
            one always find the other. "Other" is the remainder — any
            background service that doesn't belong to Keyboard (Groq
            Transcription today). Preserving registration order within
            each group means adding a new module keeps its position
            predictable.
          */}
          <ModuleGroup
            label="Searches"
            modules={modules.filter(isSearchGroup)}
            current={current}
            onChange={onChange}
            onToggle={(id, v) => void setEnabled(id, v)}
          />
          <ModuleGroup
            label="Keyboard"
            modules={modules.filter(isKeyboardGroup)}
            current={current}
            onChange={onChange}
            onToggle={(id, v) => void setEnabled(id, v)}
          />
          <ModuleGroup
            label="Other"
            modules={modules.filter((m) => !isSearchGroup(m) && !isKeyboardGroup(m))}
            current={current}
            onChange={onChange}
            onToggle={(id, v) => void setEnabled(id, v)}
          />
        </div>
      )}

      <Nav className="mt-auto pt-3 border-t border-border">
        <NavItem data-vim-item="nav:about" data-vim-nowalk=""
          icon={<Info size={16} />}
          current={current === 'about'}
          onClick={() => onChange('about')}
        >
          About
        </NavItem>
      </Nav>
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
    <Nav>
      <NavGroup>{label}</NavGroup>
      {modules.map((m) => {
        const Icon = iconFromHint(m.icon)
        return (
          <NavItem data-vim-item={`nav:module:${m.id}`} data-vim-nowalk=""
            key={m.id}
            icon={<Icon size={14} />}
            current={current === `module:${m.id}`}
            off={!m.enabled}
            onClick={() => onChange(`module:${m.id}`)}
            side={
              <SidebarToggle
                label={m.name}
                checked={m.enabled}
                onChange={(v) => onToggle(m.id, v)}
              />
            }
          >
            {m.name}
          </NavItem>
        )
      })}
    </Nav>
  )
}

function SidebarToggle({
  label,
  checked,
  onChange
}: {
  label: string
  checked: boolean
  onChange: (v: boolean) => void
}) {
  // Stopping the click keeps it from reaching the row, which would open the
  // module's page; the Switch still toggles.
  return (
    <Switch
      size="xs"
      checked={checked}
      onChange={onChange}
      label={label}
      onClick={(e) => e.stopPropagation()}
    />
  )
}
