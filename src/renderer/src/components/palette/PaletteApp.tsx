import { useEffect, useMemo, useRef, useState, type KeyboardEvent } from 'react'
import { ArrowUpDown, CornerDownLeft } from 'lucide-react'
import { usePaletteStore } from '@/store/palette-store'
import { useSettingsStore } from '@/store/settings-store'
import { SearchInput } from './SearchInput'
import { ResultsList } from './ResultsList'
import { ModeBadge } from './ModeBadge'
import { ContextMenu, revealAction, setAliasAction } from './ContextMenu'
import { AliasInputModal } from './AliasInputModal'
import { FooterHint } from './FooterHint'
import { Kbd, Hotkey } from '../ui/Kbd'

/**
 * Module ids whose entries the user can attach a Ctrl+K alias to. Both
 * modules expose stable per-item ids (app paths, command ids) so an alias
 * stored in settings still matches the same row across restarts. Adding a
 * module here is the only step needed to surface the alias menu for it.
 */
const ALIAS_CAPABLE_MODULES = new Set(['app-search', 'command-palette'])

export function PaletteApp() {
  const query = usePaletteStore((s) => s.query)
  const items = usePaletteStore((s) => s.items)
  const selectedIndex = usePaletteStore((s) => s.selectedIndex)
  const isLoading = usePaletteStore((s) => s.isLoading)
  const resolvedModuleId = usePaletteStore((s) => s.resolvedModuleId)
  const activeModuleId = usePaletteStore((s) => s.activeModuleId)
  const setQuery = usePaletteStore((s) => s.setQuery)
  const selectNext = usePaletteStore((s) => s.selectNext)
  const selectPrev = usePaletteStore((s) => s.selectPrev)
  const executeSelected = usePaletteStore((s) => s.executeSelected)
  const onPaletteShow = usePaletteStore((s) => s.onPaletteShow)
  const refresh = usePaletteStore((s) => s.refresh)
  const setSelectedIndex = usePaletteStore((s) => s.setSelectedIndex)

  const hydrate = useSettingsStore((s) => s.hydrate)
  const applyServerSettings = useSettingsStore((s) => s.applyServerSettings)
  const modules = useSettingsStore((s) => s.modules)
  const theme = useSettingsStore((s) => s.settings?.theme ?? 'system')
  const isHydrated = useSettingsStore((s) => s.isHydrated)

  const inputRef = useRef<HTMLInputElement>(null)

  // Ctrl+K context-menu open state + alias-input modal state. Both are
  // pure UI; no other layer observes them.
  const [menuOpen, setMenuOpen] = useState(false)
  const [aliasModalOpen, setAliasModalOpen] = useState(false)

  const setModuleAlias = useSettingsStore((s) => s.setModuleAlias)

  const selectedItem = items[selectedIndex]
  const canSetAlias =
    !!selectedItem && ALIAS_CAPABLE_MODULES.has(selectedItem.moduleId)
  const contextActions = useMemo(() => {
    const actions = []
    if (canSetAlias) {
      actions.push(
        setAliasAction(Boolean(selectedItem?.alias), () => {
          setMenuOpen(false)
          setAliasModalOpen(true)
        })
      )
    }
    if (selectedItem?.revealPath) actions.push(revealAction(selectedItem.revealPath))
    return actions
  }, [selectedItem?.revealPath, selectedItem?.alias, canSetAlias])
  const canOpenMenu = contextActions.length > 0

  const openContextMenuForRow = (index: number): void => {
    // Right-click should both "select" the row and open the menu; callers
    // that click on a row without any applicable action get nothing
    // (avoids an instant open-close flicker from the canOpenMenu effect
    // below). Alias-capable rows always have at least the "Set alias…"
    // action, so the menu opens even when no revealPath is set.
    const target = items[index]
    const hasAction =
      !!target &&
      (target.revealPath !== undefined || ALIAS_CAPABLE_MODULES.has(target.moduleId))
    if (!hasAction) return
    setSelectedIndex(index)
    setMenuOpen(true)
  }

  // Close the menu if the selection moves to a row without reveal actions
  // (e.g. user navigated to a UWP entry in app-search).
  useEffect(() => {
    if (!canOpenMenu) setMenuOpen(false)
  }, [canOpenMenu])

  // Restore focus to the search input when the alias modal closes. The
  // modal's own <input> steals DOM focus while it's open, and once it
  // unmounts focus would otherwise land on <body> — which has no
  // keydown handler, so arrow keys / Enter / Esc silently stop working
  // until the user clicks back into the search box. The cleanup
  // pattern fires exactly on the close transition (true → false),
  // including the unmount-during-hide case.
  useEffect(() => {
    if (!aliasModalOpen) return
    return () => {
      inputRef.current?.focus()
    }
  }, [aliasModalOpen])

  // Initial hydration
  useEffect(() => {
    void hydrate()
  }, [hydrate])

  // Theme → data-theme attribute
  useEffect(() => {
    document.documentElement.setAttribute('data-theme', theme)
  }, [theme])

  // palette:show event from main (activation or direct-launch hotkey)
  useEffect(() => {
    const unsub = window.electronAPI.onPaletteShow((payload) => {
      onPaletteShow(payload.initialModuleId)
      // Re-focus the input — the window loses focus on hide
      setTimeout(() => inputRef.current?.focus(), 0)
    })
    return unsub
  }, [onPaletteShow])

  // Settings change broadcasts
  useEffect(() => {
    const unsub = window.electronAPI.onSettingsChanged((settings) => {
      applyServerSettings(settings)
    })
    return unsub
  }, [applyServerSettings])

  // Once hydrated, populate the initial (empty query) result list.
  useEffect(() => {
    if (isHydrated) {
      setQuery('')
    }
  }, [isHydrated, setQuery])

  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>): void => {
    // While the context menu or the alias-input modal is open, they own
    // the keyboard — their own document-level capture handlers run first
    // and stop propagation for the keys they care about. The early-return
    // here is belt-and-suspenders so arrow/enter/escape keys don't
    // double-fire palette-level behaviour while the overlay is up.
    if (menuOpen || aliasModalOpen) return

    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'k' && canOpenMenu) {
      e.preventDefault()
      setMenuOpen(true)
      return
    }
    // Ctrl+R inside app-search: drop the main-process enumeration cache and
    // re-run the current search. preventDefault so the browser's built-in
    // "reload page" doesn't fire inside Electron's webContents.
    if (
      (e.ctrlKey || e.metaKey) &&
      e.key.toLowerCase() === 'r' &&
      activeModuleId === 'app-search'
    ) {
      e.preventDefault()
      void (async () => {
        await window.electronAPI.modulesAction('app-search', 'rescan')
        refresh()
      })()
      return
    }
    if (e.key === 'Escape') {
      e.preventDefault()
      void window.electronAPI.paletteHide()
      return
    }
    if (e.key === 'ArrowDown') {
      e.preventDefault()
      selectNext()
      return
    }
    if (e.key === 'ArrowUp') {
      e.preventDefault()
      selectPrev()
      return
    }
    if (e.key === 'Enter') {
      e.preventDefault()
      void executeSelected()
      return
    }

    // Quick-launch digits: when the result list is narrow enough that
    // ResultsList renders 1..N badges (≤4 items), pressing the matching
    // digit selects + runs that row. Mirrors the badge cap so the chord
    // and the visual hint stay in lock-step. We bail on modifiers so
    // future Ctrl/Alt/Cmd+digit chords stay free for other features.
    if (
      !e.ctrlKey &&
      !e.metaKey &&
      !e.altKey &&
      items.length > 0 &&
      items.length <= 4 &&
      /^[1-4]$/.test(e.key)
    ) {
      const idx = Number(e.key) - 1
      if (idx < items.length) {
        e.preventDefault()
        setSelectedIndex(idx)
        void executeSelected()
        return
      }
    }
  }

  const activeId = activeModuleId ?? resolvedModuleId
  const activeMod = activeId ? modules.find((m) => m.id === activeId) : undefined

  return (
    <div
      className="relative h-full bg-popover text-popover-foreground flex flex-col rounded-md border border-border overflow-hidden"
      onKeyDown={onKeyDown}
    >
      <div className="px-3 py-2 border-b border-border flex items-center gap-2 [-webkit-app-region:drag]">
        <SearchInput
          ref={inputRef}
          value={query}
          onChange={setQuery}
          placeholder={
            activeMod
              ? `Search ${activeMod.name.toLowerCase()}…`
              : 'Type a command or search…'
          }
        />
        {activeMod && <ModeBadge name={activeMod.name} />}
      </div>

      <ResultsList
        items={items}
        selectedIndex={selectedIndex}
        isLoading={isLoading}
        onOpenContextMenu={openContextMenuForRow}
      />

      <div className="h-10 px-2 flex items-center justify-between border-t border-border bg-toolbar text-[12px] font-medium text-muted-foreground shrink-0">
        <div className="flex items-center gap-1">
          <FooterHint
            label="Navigate"
            keys={<Kbd><ArrowUpDown size={12} strokeWidth={1.5} /></Kbd>}
          />
          <FooterHint
            label="Select"
            keys={<Kbd><CornerDownLeft size={12} strokeWidth={1.5} /></Kbd>}
          />
          {canOpenMenu && (
            <FooterHint label="Context menu" keys={<Hotkey value="Ctrl+K" />} />
          )}
          {activeModuleId === 'app-search' && (
            <FooterHint label="Rescan" keys={<Hotkey value="Ctrl+R" />} />
          )}
          <FooterHint label="Dismiss" keys={<Hotkey value="Esc" />} />
        </div>
      </div>

      <ContextMenu
        open={menuOpen}
        onClose={() => setMenuOpen(false)}
        actions={contextActions}
      />

      {selectedItem && canSetAlias && (
        <AliasInputModal
          open={aliasModalOpen}
          itemTitle={selectedItem.title}
          initialValue={selectedItem.alias ?? ''}
          onClose={() => setAliasModalOpen(false)}
          onSave={(alias) => {
            // Main's `patchModuleAlias` handles empty-string = clear, so
            // we can hand the raw input straight through. refresh() so
            // the alias chip renders (or disappears) immediately;
            // preserveSelection keeps the cursor on the just-edited
            // row instead of snapping back to the top of the list.
            void setModuleAlias(selectedItem.moduleId, selectedItem.id, alias || null).then(
              () => refresh({ preserveSelection: true })
            )
            setAliasModalOpen(false)
          }}
        />
      )}
    </div>
  )
}
